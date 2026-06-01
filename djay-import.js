/**
 * djay Pro scrolling-screenshot(s) → direct merge into knownTracks.json.
 *
 *   node djay-import.js capture.png [...more.png]              # dry-run preview
 *   node djay-import.js capture.png [...more.png] --commit     # apply to catalog
 *   node djay-import.js capture.png --debug                    # raw OCR rows
 *
 * Compile the Swift OCR tool once (it's gitignored):
 *   swiftc djay-ocr.swift -O -o djay-ocr
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

const ROW_TOL = 0.012;
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

function runOCR(imagePath) {
  const res = spawnSync("./djay-ocr", [imagePath], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`OCR failed on ${imagePath}: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

function parseImage(imagePath) {
  const fragments = runOCR(imagePath);

  for (const f of fragments) {
    f.y = 1 - f.y - f.h;
    f.cy = f.y + f.h / 2;
  }
  fragments.sort((a, b) => a.cy - b.cy || a.x - b.x);

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
      else if (c.kind === "text" && c.value.length > 1) texts.push({ text: c.value, x: item.x });
    }

    // Rightmost wins for BPM and Key (djay puts them at the far right)
    const bpm = bpms.length ? [...bpms].sort((a, b) => b.x - a.x)[0].value : null;
    const key = keys.length ? [...keys].sort((a, b) => b.x - a.x)[0].value : null;

    if (!bpm || !key) {
      if (texts.length) ignored.push({ texts: texts.map((t) => t.text), missing: !bpm ? "bpm" : "key" });
      continue;
    }

    let title = "", artist = "";
    if (texts.length >= 1) title = texts[0].text;
    if (texts.length >= 2) artist = texts[1].text;
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
