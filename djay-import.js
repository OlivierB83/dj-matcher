/**
 * OCR a djay Pro scrolling screenshot, parse it into {title, artist, bpm, key}
 * rows, and (optionally) append to manual-import.json so merge-manual-import.js
 * can ingest them into knownTracks.json.
 *
 * Workflow
 *   1. Compile the Swift OCR tool ONCE  : swiftc djay-ocr.swift -O -o djay-ocr
 *   2. Take a scrolling capture of your djay playlist (Shottr / CleanShot X)
 *   3. Preview                          : node djay-import.js capture.png
 *   4. Debug raw OCR rows               : node djay-import.js capture.png --debug
 *   5. Commit when happy                : node djay-import.js capture.png --commit
 *   6. Then                             : node merge-manual-import.js
 *
 * Tuning knobs near the top — when the parser misses rows on your screenshot,
 * either widen ROW_TOL or share the --debug dump and I'll iterate.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROW_TOL = 0.012;   // y-tolerance to cluster fragments into one row (1.2 % of image height)
const BPM_MIN = 50;
const BPM_MAX = 220;

const BPM_RE = /^\d{2,3}(\.\d+)?$/;
const CAMELOT_RE = /^(\d{1,2})\s?([AaBb])$/;

// djay (Mac Catalyst) displays keys in traditional sharp/flat notation
// ("Ab", "Db", "F#m", "Bbm"…) — convert to Camelot to stay compatible with the
// catalog. Includes enharmonic equivalents so both A# and Bb resolve to 6B.
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
  // Flat enharmonics
  Bb: "6B",  Eb: "5B",  Ab: "4B",  Gb: "2B",  Db: "3B",
  Bbm: "3A", Ebm: "2A", Abm: "1A", Gbm: "11A", Dbm: "12A",
};
const TRAD_KEY_RE = /^[A-G][#b♯♭]?m?$/;

const args = process.argv.slice(2);
const imagePath = args[0];
const debug = args.includes("--debug");
const commit = args.includes("--commit");

if (!imagePath) {
  console.error("Usage: node djay-import.js <image.png> [--debug] [--commit]");
  process.exit(64);
}
if (!fs.existsSync(imagePath)) {
  console.error(`❌ Fichier introuvable : ${imagePath}`);
  console.error("Chemin résolu absolu :", path.resolve(imagePath));
  process.exit(66);
}

/* ---- 1. Run Swift OCR ---- */
const res = spawnSync("./djay-ocr", [imagePath], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (res.status !== 0) {
  console.error("OCR error:", res.stderr || res.stdout);
  process.exit(70);
}

const fragments = JSON.parse(res.stdout);

/* ---- 2. Flip Y (Vision uses bottom-left origin) ---- */
for (const f of fragments) {
  f.y = 1 - f.y - f.h; // y now goes top-down, 0 at top
  f.cy = f.y + f.h / 2; // center-Y for clustering
}
fragments.sort((a, b) => a.cy - b.cy || a.x - b.x);

/* ---- 3. Cluster fragments into rows by vertical proximity ---- */
const rows = [];
let cur = null;
for (const f of fragments) {
  if (!cur || f.cy - cur.cy > ROW_TOL) {
    cur = { cy: f.cy, items: [] };
    rows.push(cur);
  }
  // weighted average y so the cluster center tracks growth
  cur.cy = (cur.cy * cur.items.length + f.cy) / (cur.items.length + 1);
  cur.items.push(f);
}
rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));

if (debug) {
  console.log(`Raw rows (${rows.length}):`);
  rows.forEach((r, i) => {
    const text = r.items.map((it) => `[${it.text}]`).join(" ");
    console.log(`  ${String(i).padStart(3)}  cy=${r.cy.toFixed(3)}  ${text}`);
  });
  console.log("");
}

/* ---- 4. Parse each row ---- */
function classify(text) {
  const t = text.trim();
  if (BPM_RE.test(t)) {
    const n = parseFloat(t);
    if (n >= BPM_MIN && n <= BPM_MAX) return { kind: "bpm", value: Math.round(n) };
  }
  // Camelot first (8A, 10B…)
  const c = CAMELOT_RE.exec(t);
  if (c) return { kind: "key", value: `${c[1]}${c[2].toUpperCase()}` };
  // Traditional notation (Ab, Db, F#m, Bbm…) — normalise unicode flats/sharps
  // then look up in the conversion table
  const normalized = t.replace(/♯/g, "#").replace(/♭/g, "b");
  if (TRAD_KEY_RE.test(normalized) && TRAD_TO_CAMELOT[normalized]) {
    return { kind: "key", value: TRAD_TO_CAMELOT[normalized] };
  }
  return { kind: "text", value: t };
}

const parsed = [];
const rejected = [];

for (const row of rows) {
  const bpmCandidates = [];
  const keyCandidates = [];
  const texts = [];
  for (const item of row.items) {
    const c = classify(item.text);
    if (c.kind === "bpm") bpmCandidates.push({ value: c.value, x: item.x });
    else if (c.kind === "key") keyCandidates.push({ value: c.value, x: item.x });
    else if (c.kind === "text" && c.value.length > 1) texts.push({ text: c.value, x: item.x });
  }

  // djay places BPM and Clé in the rightmost columns. A track title containing
  // a number ("1999"), or the small explicit "E" badge between title and
  // artist, would otherwise hijack these fields — pick the right-most match.
  const bpm = bpmCandidates.length
    ? [...bpmCandidates].sort((a, b) => b.x - a.x)[0].value
    : null;
  const key = keyCandidates.length
    ? [...keyCandidates].sort((a, b) => b.x - a.x)[0].value
    : null;

  if (!bpm || !key) {
    if (texts.length) rejected.push({ texts: texts.map((t) => t.text), missing: !bpm ? "bpm" : "key" });
    continue;
  }

  // texts are already sorted by x ascending. Title is the leftmost text,
  // artist the next. Album + duration columns are dropped (not stored in
  // knownTracks.json).
  let title = "", artist = "";
  if (texts.length >= 1) title = texts[0].text;
  if (texts.length >= 2) artist = texts[1].text;

  if (!title) { rejected.push({ texts: texts.map((t) => t.text), missing: "title" }); continue; }
  parsed.push({ title, artist, bpm, key });
}

/* ---- 5. Report ---- */
console.log(`✓ Parsed ${parsed.length} tracks`);
parsed.forEach((t, i) => {
  console.log(
    `  [${String(i + 1).padStart(3)}]  ${String(t.bpm).padStart(3)} BPM · ${t.key.padEnd(3)} · ${t.title}${t.artist ? "  —  " + t.artist : "  (no artist)"}`
  );
});

if (rejected.length) {
  console.log(`\n⚠ ${rejected.length} rows rejected (missing field):`);
  rejected.slice(0, 20).forEach((r) =>
    console.log(`     missing=${r.missing}   texts=${JSON.stringify(r.texts)}`)
  );
  if (rejected.length > 20) console.log(`     … et ${rejected.length - 20} autres`);
}

/* ---- 6. Optional commit ---- */
if (commit) {
  const existing = fs.existsSync("./manual-import.json")
    ? JSON.parse(fs.readFileSync("./manual-import.json", "utf8"))
    : [];
  const enriched = parsed.map((t) => ({ ...t, source: "djay_pro" }));
  fs.writeFileSync("./manual-import.json", JSON.stringify([...existing, ...enriched], null, 2));
  console.log(`\n💾 Ajouté ${enriched.length} tracks à manual-import.json`);
  console.log(`Étape suivante : node merge-manual-import.js`);
}
