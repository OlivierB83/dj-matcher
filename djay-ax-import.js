/**
 * djay-ax-import.js
 *
 * Consumes the JSON dumped by djay-ax-extract (rows of cells read directly
 * from djay's Accessibility hierarchy) and merges into knownTracks.json,
 * with djay treated as the ground-truth source for BPM + key — same
 * behaviour as djay-import.js, just bypassing OCR entirely.
 *
 * Workflow:
 *   ./djay-ax-extract > /tmp/djay-rows.json     # extract via Accessibility
 *   node djay-ax-import.js /tmp/djay-rows.json            # preview
 *   node djay-ax-import.js /tmp/djay-rows.json --commit   # apply
 *
 * For each extracted row, we classify the cells (BPM = numeric 50-220, key
 * matches Camelot or traditional notation, duration matches MM:SS, the rest
 * are textual). Title and artist are inferred from the textual cells in the
 * order djay exposes them — typically [..., duration, title, artist, BPM,
 * key, album], but the classifier is positional-agnostic so a layout
 * tweak by the user won't break us.
 *
 * Match found in catalog → overwrite bpm/key + set bpmSource/keySource to
 *   "djay_pro_ax", preserve everything else (year, danceability, popularity,
 *   genres, spotifyId, image, …)
 * No match            → add new minimal entry with source = "djay_pro_ax".
 * Dedup across rows by normalised (artist, title) — last one wins.
 * --commit            → writes a timestamped backup of knownTracks.json
 *   before mutating, then patches in place.
 */

import fs from "fs";
import { enrichTrack, buildArtistGenresCache } from "./djay-enrich.js";
import {
  normalize,
  stripTrunc,
  coreTitle,
  canonicalKey,
} from "./track-identity.js";

const KNOWN_FILE = "./knownTracks.json";

const BPM_MIN = 50;
const BPM_MAX = 220;

const BPM_RE = /^\d{2,3}(\.\d+)?$/;
const CAMELOT_RE = /^(\d{1,2})\s?([AaBb])$/;
const TRAD_KEY_RE = /^[A-G][#b♯♭]?m?$/;
const DURATION_RE = /^\d{1,2}:\d{2}$/;

const TRAD_TO_CAMELOT = {
  C: "8B",  Am: "8A",
  G: "9B",  Em: "9A",
  D: "10B", Bm: "10A",
  A: "11B", "F#m": "11A",
  E: "12B", "C#m": "12A",
  B: "1B",  "G#m": "1A",
  "F#": "2B", "D#m": "2A",
  "C#": "3B", "A#m": "3A",
  "G#": "4B", Fm: "4A",
  "D#": "5B", Cm: "5A",
  "A#": "6B", Gm: "6A",
  F: "7B",  Dm: "7A",
  Bb: "6B",  Eb: "5B",  Ab: "4B",  Gb: "2B",  Db: "3B",
  Bbm: "3A", Ebm: "2A", Abm: "1A", Gbm: "11A", Dbm: "12A",
};

/* ===== argv ===== */

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const jsonPath = args.filter((a) => !a.startsWith("--"))[0];

if (!jsonPath) {
  console.error("Usage: node djay-ax-import.js <rows.json> [--commit]");
  console.error("");
  console.error("Pour produire rows.json :");
  console.error("  ./djay-ax-extract > /tmp/djay-rows.json");
  process.exit(64);
}
if (!fs.existsSync(jsonPath)) {
  console.error(`❌ Fichier introuvable : ${jsonPath}`);
  process.exit(66);
}

/* ===== cell classification + parsing ===== */

function classifyCell(text) {
  const t = (text || "").trim();
  if (!t) return { kind: "empty" };
  if (DURATION_RE.test(t)) return { kind: "duration" };
  if (BPM_RE.test(t)) {
    const n = parseFloat(t);
    if (n >= BPM_MIN && n <= BPM_MAX) return { kind: "bpm", value: Math.round(n) };
  }
  // Camelot
  const c = CAMELOT_RE.exec(t);
  if (c) return { kind: "key", value: `${c[1]}${c[2].toUpperCase()}` };
  // Traditional notation
  const norm = t.replace(/♯/g, "#").replace(/♭/g, "b");
  if (TRAD_KEY_RE.test(norm) && TRAD_TO_CAMELOT[norm]) {
    return { kind: "key", value: TRAD_TO_CAMELOT[norm] };
  }
  return { kind: "text", value: t };
}

function parseRow(cells) {
  let bpm = null, key = null;
  const texts = [];
  for (const raw of cells) {
    const c = classifyCell(raw);
    if (c.kind === "bpm" && !bpm) bpm = c.value;
    else if (c.kind === "key" && !key) key = c.value;
    else if (c.kind === "text") texts.push(c.value);
    // empty + duration are dropped
  }
  if (!bpm || !key) return { ok: false, reason: !bpm ? "no-bpm" : "no-key" };

  // The textual cells, in djay's order, are typically [title, artist,
  // album]. Take the first two non-empty as title + artist; album is
  // intentionally dropped (the catalog doesn't store it).
  const title = texts[0] || "";
  const artist = texts[1] || "";
  if (!title) return { ok: false, reason: "no-title" };
  return { ok: true, title, artist, bpm, key };
}

/* ===== catalog index ===== */

function buildIndex(catalog) {
  // Two indexes: by-artist lets us scope candidates fast; by-canonical
  // lets findMatch fall back when "Ça m'énerve - Radio Edit" needs to
  // collide with a catalog "Ça m'énerve".
  const byArtist = new Map();
  const byCanonical = new Map();
  catalog.forEach((entry, index) => {
    const a = normalize(entry.artist);
    const item = {
      entry,
      index,
      normTitle: normalize(entry.title),
      canonNormTitle: normalize(coreTitle(entry.title)),
    };
    if (!byArtist.has(a)) byArtist.set(a, []);
    byArtist.get(a).push(item);
    byCanonical.set(canonicalKey(entry.artist, entry.title), item);
  });
  return { byArtist, byCanonical };
}

function findMatch({ byArtist, byCanonical }, djayTrack) {
  const a = normalize(djayTrack.artist);
  const tTrunc = normalize(stripTrunc(djayTrack.title));
  if (!a || !tTrunc) return null;

  const list = byArtist.get(a);
  if (!list) {
    // Last-ditch: catalog might know this song under a different version
    // suffix (post-dedup catalog has the canonical title only).
    return byCanonical.get(canonicalKey(djayTrack.artist, djayTrack.title)) || null;
  }

  // Pass 1 — exact normalised title (cheap, covers most matches)
  let m = list.find((c) => c.normTitle === tTrunc);
  if (m) return m;

  // Pass 2 — catalog title is a prefix of djay's (catalog "Ça m'énerve" vs
  // djay "Ça m'énerve - Radio Edit"), or djay's is a prefix of catalog's
  // (djay-side column truncation "Ça m'éner…" vs catalog "Ça m'énerve").
  m = list.find(
    (c) =>
      c.normTitle.startsWith(tTrunc + " ") ||
      c.normTitle.startsWith(tTrunc) ||
      tTrunc.startsWith(c.normTitle + " ") ||
      tTrunc.startsWith(c.normTitle)
  );
  if (m) return m;

  // Pass 3 — canonical key (suffix-stripped on both sides). The previous
  // passes miss when djay says "Ça m'énerve - Radio Edit" but the catalog
  // says "Ça m'énerve - Single Version" — both should collapse to the
  // same canonical "Ça m'énerve".
  const djayCanon = normalize(coreTitle(stripTrunc(djayTrack.title)));
  m = list.find((c) => c.canonNormTitle === djayCanon);
  return m || null;
}

/* ===== main ===== */

async function main() {
  const rowsRaw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (!Array.isArray(rowsRaw)) {
    console.error("❌ Format inattendu : on attend un tableau de rows");
    process.exit(65);
  }

  console.log(`📂 ${jsonPath} — ${rowsRaw.length} rows brutes\n`);

  const parsed = [];
  const rejected = { "no-bpm": 0, "no-key": 0, "no-title": 0 };

  for (const row of rowsRaw) {
    const cells = row.cells || [];
    const r = parseRow(cells);
    if (!r.ok) {
      rejected[r.reason]++;
      continue;
    }
    parsed.push({ title: r.title, artist: r.artist, bpm: r.bpm, key: r.key });
  }

  // Dedup the djay rows themselves by canonical key so we don't try to
  // import "Ça m'énerve" AND "Ça m'énerve - Radio Edit" as separate
  // candidates when djay's library shows both. Last wins.
  const dedup = new Map();
  for (const t of parsed) dedup.set(canonicalKey(t.artist, t.title), t);
  const deduped = [...dedup.values()];

  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const indexes = buildIndex(catalog);

  const updates = [];
  const adds = [];
  let alreadyMatching = 0;
  for (const djay of deduped) {
    const m = findMatch(indexes, djay);
    if (m) {
      const before = { bpm: m.entry.bpm, key: m.entry.key };
      if (before.bpm === djay.bpm && before.key === djay.key) {
        alreadyMatching++;
        continue;
      }
      updates.push({ catIndex: m.index, before, djay, catEntry: m.entry });
    } else {
      adds.push(djay);
    }
  }

  console.log("=== Bilan ===");
  console.log(`Rows OCR-free parsées : ${parsed.length}`);
  console.log(`  après dédup        : ${deduped.length}`);
  console.log(`Rows rejetées        : no-bpm=${rejected["no-bpm"]} · no-key=${rejected["no-key"]} · no-title=${rejected["no-title"]}`);
  console.log(`Déjà à jour (BPM+key identiques) : ${alreadyMatching}`);
  console.log(`Catalogue à mettre à jour       : ${updates.length}`);
  console.log(`Nouvelles entrées à ajouter      : ${adds.length}`);

  if (updates.length) {
    console.log(`\nÉchantillon mises à jour (max 20) :`);
    updates.slice(0, 20).forEach((u) => {
      console.log(
        `  ${String(u.before.bpm ?? "?").padStart(3)}/${String(u.before.key ?? "?").padEnd(3)} → ${
          String(u.djay.bpm).padStart(3)
        }/${u.djay.key.padEnd(3)}  ·  ${u.catEntry.artist} — ${u.catEntry.title}`
      );
    });
    if (updates.length > 20) console.log(`  … et ${updates.length - 20} autres`);
  }

  if (adds.length) {
    console.log(`\nÉchantillon nouveaux ajouts (max 20) :`);
    adds.slice(0, 20).forEach((a) => {
      console.log(`  ${String(a.bpm).padStart(3)}/${a.key.padEnd(3)}  ·  ${a.artist} — ${a.title}`);
    });
    if (adds.length > 20) console.log(`  … et ${adds.length - 20} autres`);
  }

  if (!commit) {
    console.log(`\nMode preview. Pour appliquer : ajoute --commit à la commande.`);
    return;
  }

  const backupFile = `./knownTracks.bak.${Date.now()}.json`;
  fs.copyFileSync(KNOWN_FILE, backupFile);
  console.log(`\n💾 Backup : ${backupFile}`);

  // Update existing matches (BPM + key only; never overwrite enrichment
  // that earlier runs put in place).
  for (const u of updates) {
    catalog[u.catIndex] = {
      ...catalog[u.catIndex],
      bpm: u.djay.bpm,
      key: u.djay.key,
      bpmSource: "djay_pro_ax",
      keySource: "djay_pro_ax",
    };
  }

  // Build the new entries first, with djay's ground-truth fields, then
  // enrich them via Spotify / ReccoBeats / getsongbpm / songstats before
  // pushing into the catalog. We persist after each enrichment so the
  // catalog ends up with partial progress if the user aborts mid-run.
  //
  // The artist-genres cache is the main lever for keeping Songstats
  // spend under control. Pre-seed it from every catalog entry that
  // already has genres; the cascade in enrichTrack will then short-
  // circuit for any new track whose primary artist we already know.
  // We pass the same Map by reference, so genres resolved mid-run also
  // benefit subsequent same-artist tracks in this same run.
  console.log(`\n=== Enrichissement des ${adds.length} nouvelles entrées ===`);
  const artistGenresCache = buildArtistGenresCache(catalog);
  console.log(`   cache artistes pré-chargé : ${artistGenresCache.size} artistes`);
  const enrichStats = {
    spotify: 0,
    popularity: 0,
    danceability: 0,
    genres: 0,
    cacheHit: 0,
    songstats: 0,
  };
  const newEntries = [];

  for (let i = 0; i < adds.length; i++) {
    const a = adds[i];
    const base = {
      artist: a.artist,
      title: a.title,
      bpm: a.bpm,
      key: a.key,
      source: "djay_pro_ax",
      bpmSource: "djay_pro_ax",
      keySource: "djay_pro_ax",
    };
    try {
      await enrichTrack(base, { artistGenresCache });
    } catch (e) {
      console.error(`   ⚠️  enrich erreur ${a.artist} — ${a.title} : ${e.message}`);
    }
    if (base.spotifyId) enrichStats.spotify++;
    if (base.popularity != null) enrichStats.popularity++;
    if (base.danceability != null) enrichStats.danceability++;
    if (base.genres?.length) enrichStats.genres++;
    if (base.genresSource?.startsWith("cached:")) enrichStats.cacheHit++;
    if (base.genresSource === "songstats") enrichStats.songstats++;
    newEntries.push(base);
    catalog.push(base);

    if ((i + 1) % 10 === 0 || i === adds.length - 1) {
      // Persist incrementally so a Ctrl-C doesn't lose minutes of API work
      fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
      console.log(
        `   [${String(i + 1).padStart(3)}/${adds.length}] · ` +
          `spotify=${enrichStats.spotify} · pop=${enrichStats.popularity} · ` +
          `dance=${enrichStats.danceability} · ` +
          `genres=${enrichStats.genres} (cache=${enrichStats.cacheHit} · songstats=${enrichStats.songstats})`
      );
    }
  }

  // Final write (covers the case where adds.length wasn't a multiple of 10
  // and also the no-adds case where the updates above haven't been flushed)
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));

  console.log(
    `\n✓ ${KNOWN_FILE} : ${updates.length} pistes corrigées, ${adds.length} ajoutées, ${catalog.length} au total`
  );
  console.log(
    `   Enrichissement : spotifyId=${enrichStats.spotify}/${adds.length} · ` +
      `pop=${enrichStats.popularity}/${adds.length} · ` +
      `dance=${enrichStats.danceability}/${adds.length} · ` +
      `genres=${enrichStats.genres}/${adds.length}`
  );
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
