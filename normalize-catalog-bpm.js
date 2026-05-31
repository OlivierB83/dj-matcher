import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const BACKUP_FILE = `./knownTracks.bak.${Date.now()}.json`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Apply the same rule used by catalog-builder.js at write time:
 *   bpm > 180 → /2
 *   bpm < 70  → x2
 *
 * Historical catalog entries pre-date this rule, so plenty of tracks sit at
 * 232 (should be 116), 54 (should be 108), etc. This script re-applies the
 * normalisation in place.
 */
function normalizeBpm(value) {
  let bpm = Number(value);
  if (!bpm) return null;
  if (bpm > 180) bpm = bpm / 2;
  if (bpm < 70) bpm = bpm * 2;
  return Math.round(bpm);
}

function main() {
  if (!fs.existsSync(KNOWN_FILE)) {
    console.error(`❌ ${KNOWN_FILE} not found.`);
    process.exit(1);
  }

  const tracks = readJson(KNOWN_FILE);
  const total = tracks.length;

  const changes = [];

  tracks.forEach((t, i) => {
    if (t.bpm == null) return;
    const before = Math.round(Number(t.bpm));
    const after = normalizeBpm(before);
    if (after === null) return;
    if (after !== before) {
      changes.push({ i, artist: t.artist, title: t.title, before, after, source: t.source });
      tracks[i] = { ...t, bpm: after };
    }
  });

  console.log(`Total tracks : ${total}`);
  console.log(`BPM hors plage (>180 ou <70) : ${changes.length}`);
  console.log("");

  if (changes.length === 0) {
    console.log("✅ Catalogue déjà normalisé. Rien à faire.");
    return;
  }

  // Summary by source
  const bySource = {};
  changes.forEach((c) => {
    bySource[c.source || "unknown"] = (bySource[c.source || "unknown"] || 0) + 1;
  });
  console.log("Par source :");
  Object.entries(bySource).forEach(([src, n]) => console.log(`  ${src.padEnd(12)} ${n}`));
  console.log("");

  // First 20 changes
  console.log("Premiers changements :");
  changes.slice(0, 20).forEach((c) => {
    console.log(
      `  [${c.source}] ${c.before} → ${c.after} BPM · ${c.artist} — ${c.title}`
    );
  });
  if (changes.length > 20) {
    console.log(`  … et ${changes.length - 20} autres`);
  }
  console.log("");

  // Backup + write
  fs.copyFileSync(KNOWN_FILE, BACKUP_FILE);
  writeJson(KNOWN_FILE, tracks);

  console.log(`💾 Backup écrit : ${BACKUP_FILE}`);
  console.log(`✅ ${KNOWN_FILE} mis à jour : ${changes.length} BPM corrigés.`);
}

main();
