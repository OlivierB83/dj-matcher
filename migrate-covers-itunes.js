/**
 * migrate-covers-itunes.js
 *
 * Migre les pochettes du CDN Spotify (i.scdn.co) vers l'API iTunes Search
 * d'Apple (mzstatic.com) pour retirer toute dépendance Spotify au runtime
 * de l'app. Ajoute aussi appleUrl (lien Apple Music) utilisable en
 * pré-écoute.
 *
 * Stratégie par entrée, dans l'ordre jusqu'à un hit :
 *   1. term="Artist Title"            (complet)
 *   2. term="PrimaryArtist CoreTitle" (sans feat./suffixes)
 * Match validé par comparaison normalisée artiste + titre (token subset),
 * pour éviter de coller la pochette d'un autre morceau.
 *
 * Reprise sur interruption : les entrées avec imageSource:"itunes" sont
 * sautées. Écriture sur disque toutes les 25 entrées.
 * En cas de miss, l'ancienne image (Spotify) est conservée.
 *
 *   node migrate-covers-itunes.js              # preview, 20 entrées, n'écrit rien
 *   node migrate-covers-itunes.js --commit     # tout le catalogue
 */

import fs from "fs";
import { normalize, coreTitle, primaryArtist, stripTrunc, unparenthesizeVersionMeta } from "./track-identity.js";

const KNOWN_FILE = "./knownTracks.json";
const THROTTLE_MS = 2000;
const PERSIST_EVERY = 25;
const MAX_BACKOFF_RETRIES = 4;

const commit = process.argv.includes("--commit");
const MAX = commit ? Infinity : 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokensOf(s) {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

function tokenSubset(a, b) {
  // true si tous les tokens de a sont dans b (ou l'inverse)
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return false;
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function titleMatches(catalogTitle, itunesTitle) {
  const a = coreTitle(stripTrunc(unparenthesizeVersionMeta(catalogTitle)));
  const b = coreTitle(stripTrunc(unparenthesizeVersionMeta(itunesTitle)));
  if (normalize(a) === normalize(b)) return true;
  return tokenSubset(tokensOf(a), tokensOf(b));
}

function artistMatches(catalogArtist, itunesArtist) {
  const a = tokensOf(catalogArtist);
  const b = tokensOf(itunesArtist);
  if (tokenSubset(a, b)) return true;
  // au moins l'artiste principal présent
  return tokenSubset(tokensOf(primaryArtist(catalogArtist)), b);
}

async function itunesSearch(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5&country=FR`;
  let backoff = 30_000;
  for (let attempt = 0; attempt <= MAX_BACKOFF_RETRIES; attempt++) {
    const r = await fetch(url);
    if (r.status === 403 || r.status === 429) {
      console.log(`   ⏳ rate-limit iTunes (HTTP ${r.status}), pause ${backoff / 1000}s…`);
      await sleep(backoff);
      backoff *= 2;
      continue;
    }
    if (!r.ok) return [];
    // iTunes renvoie parfois text/javascript — on parse à la main
    const text = await r.text();
    try {
      return JSON.parse(text).results || [];
    } catch {
      return [];
    }
  }
  throw new Error("rate-limit iTunes persistant, abandon du run");
}

function pickMatch(results, artist, title) {
  for (const r of results) {
    if (!r.artworkUrl100) continue;
    if (artistMatches(artist, r.artistName || "") && titleMatches(title, r.trackName || "")) {
      return r;
    }
  }
  return null;
}

async function findItunesTrack(artist, title) {
  const q1 = `${artist} ${title}`;
  const hit1 = pickMatch(await itunesSearch(q1), artist, title);
  if (hit1) return hit1;
  await sleep(THROTTLE_MS / 2);

  const core = coreTitle(stripTrunc(unparenthesizeVersionMeta(title)));
  const q2 = `${primaryArtist(artist)} ${core}`;
  if (normalize(q2) === normalize(q1)) return null;
  return pickMatch(await itunesSearch(q2), artist, title);
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const eligible = catalog
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.artist && t.title && t.imageSource !== "itunes");

  console.log(`Total catalogue            : ${catalog.length}`);
  console.log(`À migrer (hors déjà fait)  : ${eligible.length}`);
  console.log(`Limite ce run              : ${MAX === Infinity ? "tout" : MAX}`);
  console.log(commit ? "" : "Mode preview : rien ne sera écrit. --commit pour migrer.\n");

  const stats = { found: 0, missed: 0 };
  const misses = [];
  let processed = 0;

  for (const { t, i } of eligible) {
    if (processed >= MAX) break;
    processed++;

    try {
      const hit = await findItunesTrack(t.artist, t.title);
      if (hit) {
        catalog[i] = {
          ...t,
          image: hit.artworkUrl100.replace("100x100bb", "600x600bb"),
          appleUrl: hit.trackViewUrl || null,
          imageSource: "itunes",
          album: t.album || hit.collectionName || null,
          year: t.year || (hit.releaseDate || "").slice(0, 4) || null,
        };
        stats.found++;
        if (!commit) console.log(`  ✓ ${t.artist} — ${t.title}\n      → ${hit.artistName} — ${hit.trackName}`);
      } else {
        stats.missed++;
        misses.push({ artist: t.artist, title: t.title });
        if (!commit) console.log(`  ✗ ${t.artist} — ${t.title}`);
      }
    } catch (e) {
      console.error(`❌ ${e.message} — arrêt propre, reprise possible en relançant.`);
      break;
    }

    if (commit && processed % PERSIST_EVERY === 0) {
      fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
      console.log(`[${String(processed).padStart(4)}/${eligible.length}] itunes=${stats.found} · miss=${stats.missed}`);
    }

    await sleep(THROTTLE_MS);
  }

  if (commit) {
    fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
    fs.writeFileSync("./itunes-cover-misses.json", JSON.stringify(misses, null, 2));
  }

  console.log("\n=== Bilan ===");
  console.log(`Traités     : ${processed}`);
  console.log(`Migrés      : ${stats.found} (${processed ? Math.round(100 * stats.found / processed) : 0}%)`);
  console.log(`Non trouvés : ${stats.missed}${commit ? " (gardent leur pochette actuelle, listés dans itunes-cover-misses.json)" : ""}`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
