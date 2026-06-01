/**
 * djay Pro scrolling-screenshot(s) → direct merge into knownTracks.json.
 *
 *   node djay-import.js capture.png [...more.png]              # dry-run preview
 *   node djay-import.js capture.png [...more.png] --commit     # apply to catalog
 *   node djay-import.js capture.png --debug                    # raw OCR rows
 *
 * Requires Tesseract (Apple Vision proved unreliable on dense tables):
 *   brew install tesseract tesseract-lang
 *
 * Behaviour:
 *   - djay is treated as the ground-truth source for BPM and key.
 *   - For every parsed (artist, title), we find a catalog match (artist exact +
 *     title prefix-match to handle djay's "…" truncation).
 *   - Match found  → overwrite `bpm`, `key`; set `bpmSource` and `keySource`
 *                    to "djay_pro"; ALL other fields (year, danceability,
 *                    popularity, genres, spotifyId, …) are preserved.
 *   - No match     → add as new entry {artist, title, bpm, key,
 *                    source: "djay_pro", bpmSource, keySource}.
 *   - Multiple captures referencing the same track → the last one wins.
 *   - A timestamped backup of knownTracks.json is written before any change.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const KNOWN_FILE = "./knownTracks.json";

const BPM_MIN = 50;
const BPM_MAX = 220;

const BPM_RE = /^\d{2,3}(\.\d+)?$/;
const CAMELOT_RE = /^(\d{1,2})\s?([AaBb])$/;
const TRAD_KEY_RE = /^[A-G][#b♯♭]?m?$/;

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
const debug = args.includes("--debug");
const imagePaths = args.filter((a) => !a.startsWith("--"));

if (!imagePaths.length) {
  console.error("Usage: node djay-import.js <image.png> [...more.png] [--debug] [--commit]");
  process.exit(64);
}
for (const p of imagePaths) {
  if (!fs.existsSync(p)) {
    console.error(`❌ Fichier introuvable : ${p}`);
    console.error("Chemin résolu absolu :", path.resolve(p));
    process.exit(66);
  }
}

/* ===== helpers ===== */

/** djay-friendly catalog normalisation, same as merge-manual-import.js. */
function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip djay's "..." or "…" truncation marker. */
function stripTrunc(text) {
  return String(text || "").replace(/\s*[.…]{1,}$/u, "").trim();
}

function classify(text) {
  const t = text.trim();
  if (BPM_RE.test(t)) {
    const n = parseFloat(t);
    if (n >= BPM_MIN && n <= BPM_MAX) return { kind: "bpm", value: Math.round(n) };
  }
  const c = CAMELOT_RE.exec(t);
  if (c) return { kind: "key", value: `${c[1]}${c[2].toUpperCase()}` };
  const normalised = t.replace(/♯/g, "#").replace(/♭/g, "b");
  if (TRAD_KEY_RE.test(normalised) && TRAD_TO_CAMELOT[normalised]) {
    return { kind: "key", value: TRAD_TO_CAMELOT[normalised] };
  }
  return { kind: "text", value: t };
}

/**
 * Resolve the tesseract binary. Homebrew typically puts it at
 *   /opt/homebrew/bin/tesseract  (Apple Silicon)
 *   /usr/local/bin/tesseract     (Intel)
 * but if the user opened the shell with a clean PATH, plain "tesseract" may
 * not resolve — so we look in both standard spots before giving up.
 */
function resolveTesseract() {
  for (const p of ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  console.error("❌ tesseract introuvable. Installation :");
  console.error("    brew install tesseract tesseract-lang");
  process.exit(127);
}

const TESSERACT_BIN = resolveTesseract();

/**
 * OCR an image with Tesseract in TSV mode. Returns fragments in the same
 * { text, confidence, x, y, w, h } shape Vision used: normalised 0–1 to
 * the image extent, with Y measured from the BOTTOM (the parser flips it).
 *
 * --psm 6  →  "Assume a single uniform block of vertically aligned text".
 *             That's exactly what djay's library table is.
 * -l fra+eng → covers the French column headers (Titre / Artiste / Album /
 *             Durée / BPM / Clé) and English/French track text.
 */
function runOCR(imagePath) {
  const dim = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", imagePath], { encoding: "utf8" });
  const W = Number(dim.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const H = Number(dim.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!W || !H) throw new Error(`Cannot read dimensions of ${imagePath}`);

  const res = spawnSync(
    TESSERACT_BIN,
    [imagePath, "-", "-l", "fra+eng", "--psm", "6", "tsv"],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`Tesseract failed on ${imagePath}: ${res.stderr || res.stdout}`);
  }

  // TSV columns:
  //   level  page  block  par  line  word  left  top  width  height  conf  text
  const lines = res.stdout.split("\n");
  const fragments = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split("\t");
    if (row.length < 12) continue;
    const text = row[11];
    if (!text || !text.trim()) continue;
    const left = Number(row[6]);
    const top = Number(row[7]);
    const width = Number(row[8]);
    const height = Number(row[9]);
    const conf = Number(row[10]) / 100;
    if (!isFinite(left) || !isFinite(top) || width <= 0 || height <= 0) continue;
    fragments.push({
      text: text.trim(),
      confidence: conf,
      x: left / W,
      // Flip to bottom-origin so the parser sees the same convention Vision used
      y: 1 - (top + height) / H,
      w: width / W,
      h: height / H,
    });
  }
  return fragments;
}

function parseImage(imagePath) {
  let fragments = runOCR(imagePath);

  // Compute Q1 height across ALL fragments BEFORE filtering — the cover-art
  // outliers are exactly what we want to spot relative to the typical row
  // text height. Real djay row glyphs cluster at Q1; cover-art blobs run
  // 2–4× taller.
  const allHeights = [...fragments.map((f) => f.h)].sort((a, b) => a - b);
  const q1H = allHeights[Math.floor(allHeights.length * 0.25)] || 0.005;
  const TALL_FRAGMENT = q1H * 2.5;

  // Strip cover-art OCR noise. Three orthogonal signals, any one drops the
  // fragment:
  //   (1) low confidence (Tesseract self-reported < 55 %)
  //   (2) ends inside the leftmost ~7 % of the image — the thumbnail band
  //   (3) over 2.5× the typical row text height — oversized blob
  fragments = fragments.filter((f) => {
    if (f.confidence < 0.55) return false;
    if (f.x + f.w < 0.07) return false;
    if (f.h > TALL_FRAGMENT) return false;
    return true;
  });

  for (const f of fragments) {
    f.y = 1 - f.y - f.h;
    f.cy = f.y + f.h / 2;
  }
  fragments.sort((a, b) => a.cy - b.cy || a.x - b.x);

  // Row clustering tolerance: 1.8 × Q1 of the FILTERED fragments. After
  // we've evicted the giant cover-art blobs the remaining heights cluster
  // tightly around the row-text glyph height, so the row tolerance lands
  // at ~1.5–2 line heights — enough slack for tiny per-glyph baseline
  // variation, tight enough to keep adjacent rows separate even on long
  // scrolling captures.
  const ROW_TOL = Math.max(q1H * 1.8, 0.0012);

  const rows = [];
  let cur = null;
  for (const f of fragments) {
    if (!cur || f.cy - cur.cy > ROW_TOL) {
      cur = { cy: f.cy, items: [] };
      rows.push(cur);
    }
    cur.cy = (cur.cy * cur.items.length + f.cy) / (cur.items.length + 1);
    cur.items.push(f);
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));

  if (debug) {
    console.log(`\n--- ${imagePath} : ${rows.length} rows ---`);
    rows.forEach((r, i) =>
      console.log(`  ${String(i).padStart(3)}  ${r.items.map((it) => `[${it.text}]`).join(" ")}`)
    );
  }

  const parsed = [];
  const ignored = [];

  for (const row of rows) {
    const bpms = [], keys = [], texts = [];
    for (const item of row.items) {
      const c = classify(item.text);
      if (c.kind === "bpm") bpms.push({ value: c.value, x: item.x });
      else if (c.kind === "key") keys.push({ value: c.value, x: item.x });
      else if (c.kind === "text" && c.value.length > 0) {
        texts.push({ text: c.value, x: item.x, w: item.w });
      }
    }

    // Rightmost wins for BPM and Key (djay puts them at the far right)
    const bpm = bpms.length ? [...bpms].sort((a, b) => b.x - a.x)[0].value : null;
    const key = keys.length ? [...keys].sort((a, b) => b.x - a.x)[0].value : null;

    if (!bpm || !key) {
      if (texts.length) ignored.push({ texts: texts.map((t) => t.text), missing: !bpm ? "bpm" : "key" });
      continue;
    }

    // Tesseract returns word-level fragments — "Buddy Holly" comes back as
    // two entries [Buddy] and [Holly]. Group adjacent fragments (small X
    // gap) into a single cell so titles like "The Shock Of The Lightning"
    // survive whole. Big X gaps mean we crossed a column boundary
    // (Title → Artist → Album → Durée).
    const sorted = [...texts].sort((a, b) => a.x - b.x);
    const cells = [];
    const GAP_THRESHOLD = 0.012; // gap between djay columns is ≥ 0.017, intra-word gaps ≤ 0.010
    for (const t of sorted) {
      const last = cells[cells.length - 1];
      if (!last) {
        cells.push({ words: [t.text], endX: t.x + t.w });
      } else if (t.x - last.endX > GAP_THRESHOLD) {
        cells.push({ words: [t.text], endX: t.x + t.w });
      } else {
        last.words.push(t.text);
        last.endX = Math.max(last.endX, t.x + t.w);
      }
    }
    const cellTexts = cells.map((c) => c.words.join(" "));

    let title = "", artist = "";
    if (cellTexts.length >= 1) title = cellTexts[0];
    if (cellTexts.length >= 2) artist = cellTexts[1];
    if (!title) { ignored.push({ texts: [], missing: "title" }); continue; }
    parsed.push({ title, artist, bpm, key });
  }

  return { parsed, ignored };
}

/* ===== catalog matching ===== */

function buildIndex(catalog) {
  // Map normalised "artist|title" → list of {entry, index}
  const byArtist = new Map();
  catalog.forEach((entry, index) => {
    const a = normalize(entry.artist);
    if (!byArtist.has(a)) byArtist.set(a, []);
    byArtist.get(a).push({ entry, index, normTitle: normalize(entry.title) });
  });
  return byArtist;
}

function findMatch(byArtist, djayTrack) {
  const a = normalize(djayTrack.artist);
  const tTrunc = normalize(stripTrunc(djayTrack.title));
  if (!a || !tTrunc) return null;
  const list = byArtist.get(a);
  if (!list) return null;

  // Exact normalised match first
  let m = list.find((c) => c.normTitle === tTrunc);
  if (m) return m;
  // Otherwise: catalog title starts with djay's (truncation-aware)
  m = list.find((c) => c.normTitle.startsWith(tTrunc + " ") || c.normTitle.startsWith(tTrunc));
  return m || null;
}

/* ===== main ===== */

async function main() {
  // 1. OCR all captures
  const allParsed = [];
  const allIgnored = [];

  for (const img of imagePaths) {
    console.log(`📷 ${img}`);
    const { parsed, ignored } = parseImage(img);
    console.log(`   → ${parsed.length} pistes parsées, ${ignored.length} lignes ignorées`);
    allParsed.push(...parsed);
    allIgnored.push(...ignored);
  }

  // 2. Dedupe across captures by (artist, title) — last one wins
  const dedupKey = (t) => normalize(t.artist) + "|" + normalize(stripTrunc(t.title));
  const dedupMap = new Map();
  for (const t of allParsed) dedupMap.set(dedupKey(t), t);
  const dedupedParsed = [...dedupMap.values()];

  // 3. Load catalog
  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const byArtist = buildIndex(catalog);

  // 4. Categorise parsed tracks: update vs add
  const updates = []; // { catIndex, before, djay }
  const adds = [];   // { djay }
  for (const djay of dedupedParsed) {
    const m = findMatch(byArtist, djay);
    if (m) {
      const before = { bpm: m.entry.bpm, key: m.entry.key };
      if (before.bpm === djay.bpm && before.key === djay.key) continue; // no change
      updates.push({ catIndex: m.index, before, djay, catEntry: m.entry });
    } else {
      adds.push(djay);
    }
  }

  /* ===== report ===== */
  console.log("\n=== Bilan ===");
  console.log(`Captures              : ${imagePaths.length}`);
  console.log(`Pistes OCR parsées    : ${allParsed.length}`);
  console.log(`  après dédup         : ${dedupedParsed.length}`);
  console.log(`Lignes ignorées (OCR) : ${allIgnored.length} (en-tête / pochettes / noise)`);
  console.log(`Catalogue à mettre à jour : ${updates.length}`);
  console.log(`Nouvelles entrées à ajouter : ${adds.length}`);

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

  /* ===== apply ===== */
  const backupFile = `./knownTracks.bak.${Date.now()}.json`;
  fs.copyFileSync(KNOWN_FILE, backupFile);

  for (const u of updates) {
    catalog[u.catIndex] = {
      ...catalog[u.catIndex],
      bpm: u.djay.bpm,
      key: u.djay.key,
      bpmSource: "djay_pro",
      keySource: "djay_pro",
    };
  }
  for (const a of adds) {
    catalog.push({
      artist: a.artist,
      title: a.title,
      bpm: a.bpm,
      key: a.key,
      source: "djay_pro",
      bpmSource: "djay_pro",
      keySource: "djay_pro",
    });
  }

  fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
  console.log(`\n💾 Backup : ${backupFile}`);
  console.log(`✓ ${KNOWN_FILE} mis à jour : ${updates.length} pistes corrigées, ${adds.length} ajoutées`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
