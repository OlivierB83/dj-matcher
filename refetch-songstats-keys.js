import fs from "fs";
import "dotenv/config";

const KNOWN_FILE = "./knownTracks.json";
const BACKUP_FILE = `./knownTracks.bak.${Date.now()}.json`;
const CHECKPOINT_EVERY = 100;
const THROTTLE_MS = 150;

const GETSONGBPM_API_KEY = process.env.GETSONGBPM_API_KEY;
if (!GETSONGBPM_API_KEY) {
  console.error("❌ GETSONGBPM_API_KEY missing from .env");
  process.exit(1);
}

/* ===== helpers (mirroring catalog-builder.js) ===== */

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/feat\..*/gi, "")
    .replace(/ft\..*/gi, "")
    .replace(/with .*/gi, "")
    .replace(/- remix.*/gi, "")
    .replace(/- radio edit.*/gi, "")
    .replace(/- edit.*/gi, "")
    .replace(/version.*/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBpm(bpm) {
  let v = Number(bpm);
  if (!v) return null;
  if (v > 180) v = v / 2;
  if (v < 70) v = v * 2;
  return Math.round(v);
}

function normalizeKey(rawKey) {
  if (!rawKey) return null;
  const cleaned = String(rawKey).trim();
  // Already Camelot? Keep as-is.
  if (/^[0-9]{1,2}[AB]$/i.test(cleaned)) return cleaned.toUpperCase();
  // Otherwise pass through — App.jsx will toCamelot() it.
  return cleaned;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ===== GetSongBPM search ===== */

async function searchGetSongBPM(track) {
  const lookup = `song:${track.title} artist:${track.artist}`;
  const url =
    `https://api.getsong.co/search/` +
    `?api_key=${GETSONGBPM_API_KEY}` +
    `&type=both` +
    `&lookup=${encodeURIComponent(lookup)}` +
    `&limit=5`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { ok: false, reason: `network:${err.message}` };
  }
  if (!response.ok) return { ok: false, reason: `http:${response.status}` };

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  const results = data.search || [];
  if (!results.length) return { ok: false, reason: "no-results" };

  const targetTitle = normalize(track.title);
  const targetArtist = normalize(track.artist);

  const best =
    results.find(
      (s) =>
        normalize(s.title) === targetTitle &&
        normalize(s.artist?.name) === targetArtist
    ) ||
    results.find((s) => normalize(s.title) === targetTitle) ||
    null; // Don't fall back to first-result blindly — too risky on a re-fetch

  if (!best) return { ok: false, reason: "no-match" };

  const bpm = normalizeBpm(best.tempo);
  const key = normalizeKey(best.key_of);
  if (!bpm || !key) return { ok: false, reason: "missing-bpm-or-key" };

  return { ok: true, bpm, key };
}

/* ===== main ===== */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function main() {
  const tracks = readJson(KNOWN_FILE);
  const targets = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.source === "songstats");

  console.log(`Total catalogue : ${tracks.length}`);
  console.log(`À re-tester     : ${targets.length} (source: songstats)`);
  console.log(`Throttle        : ${THROTTLE_MS}ms`);
  console.log(`ETA             : ~${Math.round((targets.length * THROTTLE_MS) / 60000)} min`);
  console.log("");

  fs.copyFileSync(KNOWN_FILE, BACKUP_FILE);
  console.log(`💾 Backup : ${BACKUP_FILE}\n`);

  let updated = 0;
  let unchanged = 0;
  const reasons = {};
  const changes = [];

  for (let n = 0; n < targets.length; n++) {
    const { t, i } = targets[n];

    const res = await searchGetSongBPM(t);

    if (res.ok) {
      const beforeBpm = t.bpm;
      const beforeKey = t.key;
      const bpmChanged = res.bpm !== beforeBpm;
      const keyChanged = res.key !== beforeKey;
      if (bpmChanged || keyChanged) {
        changes.push({
          artist: t.artist,
          title: t.title,
          beforeBpm, afterBpm: res.bpm,
          beforeKey, afterKey: res.key,
        });
      }
      tracks[i] = { ...t, bpm: res.bpm, key: res.key, source: "getsongbpm" };
      updated++;
    } else {
      unchanged++;
      reasons[res.reason] = (reasons[res.reason] || 0) + 1;
    }

    if ((n + 1) % CHECKPOINT_EVERY === 0) {
      writeJson(KNOWN_FILE, tracks);
      console.log(
        `[${n + 1}/${targets.length}] updated=${updated} unchanged=${unchanged}`
      );
    }

    await sleep(THROTTLE_MS);
  }

  writeJson(KNOWN_FILE, tracks);

  console.log("\n=== Résumé ===");
  console.log(`Mis à jour (songstats → getsongbpm) : ${updated}`);
  console.log(`Inchangés : ${unchanged}`);
  console.log("Raisons d'échec :");
  Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}`));

  console.log(`\nChangements effectifs (bpm OU key différent) : ${changes.length}`);
  console.log("Premiers exemples :");
  changes.slice(0, 15).forEach((c) => {
    const bpmStr = c.beforeBpm === c.afterBpm ? `${c.afterBpm}` : `${c.beforeBpm} → ${c.afterBpm}`;
    const keyStr = c.beforeKey === c.afterKey ? `${c.afterKey}` : `${c.beforeKey} → ${c.afterKey}`;
    console.log(`  ${bpmStr.padEnd(11)} ${keyStr.padEnd(11)} · ${c.artist} — ${c.title}`);
  });
  if (changes.length > 15) console.log(`  … et ${changes.length - 15} autres`);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
