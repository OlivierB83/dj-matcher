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

const ROW_TOL = 0.012;   // y-tolerance to cluster fragments into one row (1.2 % of image height)
const BPM_MIN = 50;
const BPM_MAX = 220;

const BPM_RE = /^\d{2,3}(\.\d+)?$/;
const CAMELOT_RE = /^(\d{1,2})\s?([AaBb])$/;

const args = process.argv.slice(2);
const imagePath = args[0];
const debug = args.includes("--debug");
const commit = args.includes("--commit");

if (!imagePath || !fs.existsSync(imagePath)) {
  console.error("Usage: node djay-import.js <image.png> [--debug] [--commit]");
  process.exit(64);
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
  const c = CAMELOT_RE.exec(t);
  if (c) {
    return { kind: "key", value: `${c[1]}${c[2].toUpperCase()}` };
  }
  return { kind: "text", value: t };
}

const parsed = [];
const rejected = [];

for (const row of rows) {
  let bpm = null, key = null;
  const texts = [];
  for (const item of row.items) {
    const c = classify(item.text);
    if (c.kind === "bpm" && !bpm) bpm = c.value;
    else if (c.kind === "key" && !key) key = c.value;
    else if (c.kind === "text" && c.value.length > 1) texts.push({ text: c.value, x: item.x });
  }
  if (!bpm || !key) {
    if (texts.length) rejected.push({ texts: texts.map((t) => t.text), missing: !bpm ? "bpm" : "key" });
    continue;
  }

  // Heuristic for title vs artist:
  //   In djay's library list, title sits left of BPM. Artist is the next
  //   text fragment (often visually below the title within the same row,
  //   but Vision often returns them on the same logical row).
  //   We just take the longest fragment as title; remaining join as artist.
  let title = "", artist = "";
  if (texts.length === 0) {
    /* nothing usable */
  } else if (texts.length === 1) {
    title = texts[0].text;
  } else {
    // Sort by x (already done) and assume leftmost is title (djay layout)
    title = texts[0].text;
    artist = texts.slice(1).map((t) => t.text).join(" · ").trim();
  }

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
