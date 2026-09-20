/**
 * refresh-popularity-deezer.js
 *
 * Remplace la popularité Spotify par le rang Deezer. Depuis mi-2026 l'API
 * Spotify ne renvoie plus `popularity` aux apps en mode développement, et
 * ReccoBeats sert un instantané figé. L'API Deezer est publique, sans clé.
 *
 *   rank Deezer 0 … 1 000 000  →  popularity = round(rank / 10 000)  (0 … 100)
 *
 * Deezer note plus haut que Spotify : le seuil "Populaires" est passé de 75 à 85
 * dans les deux apps (rang Deezer ≥ 850 000 ≈ 18 % du catalogue, contre 13 % avant).
 *
 * Résolution de chaque entrée : on met en concurrence
 *   - deezerId déjà connu        → GET /track/{id}
 *   - isrc présent               → GET /track/isrc:{isrc}
 *   - recherche "Artiste Titre"  → GET /search, validé par tokens artiste + titre
 * et on garde, parmi les versions de l'artiste exact, le RANG MAXIMUM : une
 * piste trouvée par ISRC peut être une édition secondaire au rang minuscule.
 *
 * Modes :
 *   node refresh-popularity-deezer.js                # lookup + écriture du catalogue (cron hebdo)
 *   node refresh-popularity-deezer.js --dry-run      # lookup, rien n'est écrit
 *   node refresh-popularity-deezer.js --cache-only   # lookup → deezer-cache.json seulement
 *                                                    #   (à utiliser quand un autre script écrit knownTracks.json)
 *   node refresh-popularity-deezer.js --apply-cache  # applique deezer-cache.json au catalogue, sans réseau
 *   … --limit=40                                    # test rapide sur les N premières entrées
 *   … --only-uncached                               # ne résout que les entrées absentes de deezer-cache.json
 *
 * Ne touche que : popularity, popularitySource, deezerId, deezerRank,
 * et isrc s'il manquait. Tout le reste (bpm/key/genres/pochettes) est laissé tel quel.
 *
 * Rate-limit Deezer : 50 requêtes / 5 s par IP → 120 ms entre requêtes,
 * pause 5 s sur "Quota limit exceeded".
 */

import fs from "fs";
import {
  canonicalKey, normalize, coreTitle, primaryArtist, stripTrunc,
  unparenthesizeVersionMeta, titleMatches, artistMatches,
} from "./track-identity.js";

const KNOWN_FILE = "./knownTracks.json";
const CACHE_FILE = "./deezer-cache.json";
const THROTTLE_MS = 120;
const PERSIST_EVERY = 100;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const cacheOnly = args.includes("--cache-only");
const applyCache = args.includes("--apply-cache");
const onlyUncached = args.includes("--only-uncached"); // ne (re)résout que les entrées absentes du cache
const LIMIT = parseInt((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || "0", 10) || Infinity; // test : --limit=40

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function deezer(path) {
  const url = "https://api.deezer.com" + path;
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try { r = await fetch(url); } catch { await sleep(2000); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000); continue; }
    const j = await r.json().catch(() => null);
    if (j && j.error) {
      if (j.error.code === 4 /* quota */) { await sleep(5000); continue; }
      return null; // 800 = no data, etc.
    }
    return j;
  }
  return null;
}

function toPopularity(rank) {
  return Math.max(0, Math.min(100, Math.round(rank / 10000)));
}

function bestOf(candidates, artist) {
  if (!candidates.length) return null;
  const wantArtists = new Set([normalize(artist), normalize(primaryArtist(artist))]);
  // 1. artiste strictement identique (évite les cover bands "Daft Punk Experience")
  const exact = candidates.filter((d) => wantArtists.has(normalize(d.artist?.name || "")));
  const pool = exact.length ? exact : candidates;
  // 2. rang le plus haut parmi les versions : c'est la popularité du morceau,
  //    pas celle d'une édition secondaire (compilation, réédition retirée…)
  return pool.sort((a, b) => b.rank - a.rank)[0];
}

async function resolve(t, cached) {
  // Une piste "readable: false" / rank 0 est une version retirée du catalogue
  // Deezer : on l'ignore. Une piste trouvée par ISRC peut être une édition
  // secondaire au rang minuscule (ex. "Summer" de Calvin Harris sur une
  // compilation à 2 632 vs 932 591 pour l'original) : on met donc TOUJOURS
  // les résultats de recherche en concurrence et on garde le rang maximum.
  const usable = (d) => d && d.rank > 0 && d.readable !== false;
  const pool = [];
  const id = t.deezerId || cached?.deezerId;
  if (id) {
    const d = await deezer(`/track/${id}`);
    if (usable(d)) pool.push({ ...d, via: "id" });
    await sleep(THROTTLE_MS);
  }
  if (t.isrc) {
    const d = await deezer(`/track/isrc:${encodeURIComponent(t.isrc)}`);
    if (usable(d)) pool.push({ ...d, via: "isrc" });
    await sleep(THROTTLE_MS);
  }
  const core = coreTitle(stripTrunc(unparenthesizeVersionMeta(t.title)));
  const q = `${primaryArtist(t.artist)} ${core}`;
  const s = await deezer(`/search?q=${encodeURIComponent(q)}&limit=5`);
  for (const d of s?.data || []) {
    if (usable(d) && artistMatches(t.artist, d.artist?.name || "") && titleMatches(t.title, d.title || "")) {
      pool.push({ ...d, via: "search" });
    }
  }
  const hit = bestOf(pool, t.artist);
  if (!hit) return null;
  return { deezerId: hit.id, rank: hit.rank, isrc: hit.isrc || t.isrc || null, via: hit.via };
}

function applyToCatalog(tracks, cache) {
  let changed = 0, unchanged = 0, missing = 0;
  const deltas = [];
  const before75 = tracks.filter((t) => (t.popularity ?? -1) >= 75).length;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const c = cache[canonicalKey(t.artist, t.title)];
    if (!c || c.rank == null) { missing++; continue; }
    const pop = toPopularity(c.rank);
    const next = {
      ...t,
      popularity: pop,
      popularitySource: "deezer",
      deezerId: c.deezerId,
      deezerRank: c.rank,
      ...(t.isrc ? {} : c.isrc ? { isrc: c.isrc } : {}),
    };
    if (pop === t.popularity && t.popularitySource === "deezer" && t.deezerRank === c.rank) { unchanged++; continue; }
    deltas.push({ before: t.popularity ?? null, after: pop, artist: t.artist, title: t.title });
    tracks[i] = next;
    changed++;
  }
  const after75 = tracks.filter((t) => (t.popularity ?? -1) >= 75).length;
  console.log(`\nMis à jour  : ${changed}`);
  console.log(`Inchangés   : ${unchanged}`);
  console.log(`Sans Deezer : ${missing} (gardent leur popularité actuelle)`);
  console.log(`Titres ≥ 75 : ${before75} → ${after75}`);
  if (deltas.length) {
    console.log(`\nPlus grosses variations :`);
    deltas
      .filter((d) => d.before != null)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
      .slice(0, 10)
      .forEach((d) => console.log(`  ${String(d.before).padStart(3)} → ${String(d.after).padStart(3)}  ·  ${d.artist} — ${d.title}`));
  }
  return changed;
}

async function main() {
  const tracks = readJson(KNOWN_FILE, null);
  if (!Array.isArray(tracks)) throw new Error(`${KNOWN_FILE} illisible`);
  const cache = readJson(CACHE_FILE, {});
  const mode = applyCache ? "apply-cache" : cacheOnly ? "cache-only" : dryRun ? "dry-run" : "apply";
  console.log(`Catalogue : ${tracks.length}  ·  cache Deezer : ${Object.keys(cache).length}  ·  mode : ${mode}\n`);

  if (!applyCache) {
    const stats = { id: 0, isrc: 0, search: 0, miss: 0 };
    let done = 0;
    for (const t of tracks) {
      if (done >= LIMIT) break;
      if (!t.artist || !t.title) continue;
      const key = canonicalKey(t.artist, t.title);
      if (onlyUncached && cache[key]) continue;
      let res;
      try { res = await resolve(t, cache[key]); } catch { res = null; }
      if (res) {
        cache[key] = { deezerId: res.deezerId, rank: res.rank, isrc: res.isrc, at: new Date().toISOString() };
        stats[res.via]++;
      } else {
        stats.miss++;
      }
      done++;
      if (done % PERSIST_EVERY === 0) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
        console.log(`[${String(done).padStart(4)}/${tracks.length}] id=${stats.id} isrc=${stats.isrc} search=${stats.search} miss=${stats.miss}`);
      }
      await sleep(THROTTLE_MS);
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`\nRésolution Deezer : id=${stats.id} · isrc=${stats.isrc} · recherche=${stats.search} · introuvables=${stats.miss}`);
    if (cacheOnly) {
      console.log(`✓ ${CACHE_FILE} écrit. Lancer --apply-cache quand knownTracks.json est libre.`);
      return;
    }
  }

  const changed = applyToCatalog(tracks, cache);
  if (dryRun) { console.log("\n(dry-run) catalogue non modifié."); return; }
  if (changed === 0) { console.log("\nRien à écrire, catalogue identique."); return; }
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(tracks, null, 2));
  console.log(`\n✓ ${KNOWN_FILE} mis à jour : ${changed} entrées.`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
