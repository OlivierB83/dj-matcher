/**
 * Lightweight weekly refresh of Spotify popularity values via ReccoBeats.
 * Designed to be run by the GitHub Actions cron — touches ONLY the
 * `popularity` field of catalog entries (and only writes if something
 * actually changed), so the git diff stays minimal and the rest of the
 * data we've built up (bpm/key/genres/danceability) is left alone.
 *
 *   node refresh-popularity.js                # apply
 *   node refresh-popularity.js --dry-run      # report what would change
 */

import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const LOOKUP_BATCH = 30; // ReccoBeats silently caps above ~40
const THROTTLE_MS = 100;

const dryRun = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookupBatch(spotifyIds) {
  const url = `https://api.reccobeats.com/v1/track?ids=${spotifyIds.join(",")}`;
  const r = await fetch(url);
  if (!r.ok) return new Map();
  const data = await r.json();
  const out = new Map();
  for (const t of data.content || []) {
    const sid = (t.href || "").split("/track/")[1];
    if (sid && t.popularity != null) out.set(sid, t.popularity);
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const tracks = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const eligible = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.spotifyId);

  console.log(`Total catalog   : ${tracks.length}`);
  console.log(`Avec spotifyId  : ${eligible.length}`);
  console.log(`Mode            : ${dryRun ? "dry-run" : "apply"}\n`);

  const chunks = chunk(eligible, LOOKUP_BATCH);
  const newPopularity = new Map();

  for (let c = 0; c < chunks.length; c++) {
    const ids = chunks[c].map(({ t }) => t.spotifyId);
    const map = await lookupBatch(ids);
    for (const [k, v] of map.entries()) newPopularity.set(k, v);
    await sleep(THROTTLE_MS);
  }
  console.log(`Popularity ReccoBeats : ${newPopularity.size}/${eligible.length}`);

  let changed = 0, unchanged = 0, missing = 0;
  const deltas = [];
  for (const { t, i } of eligible) {
    const fresh = newPopularity.get(t.spotifyId);
    if (fresh == null) { missing++; continue; }
    if (fresh === t.popularity) { unchanged++; continue; }
    deltas.push({
      before: t.popularity ?? null,
      after: fresh,
      delta: fresh - (t.popularity ?? 0),
      artist: t.artist,
      title: t.title,
    });
    tracks[i] = { ...t, popularity: fresh };
    changed++;
  }

  console.log(`\nChanged   : ${changed}`);
  console.log(`Unchanged : ${unchanged}`);
  console.log(`Manquants : ${missing}`);

  if (deltas.length) {
    console.log(`\nPlus grosses variations :`);
    deltas
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10)
      .forEach((d) =>
        console.log(`  ${String(d.before ?? "?").padStart(3)} → ${String(d.after).padStart(3)} (${d.delta > 0 ? "+" : ""}${d.delta})  ·  ${d.artist} — ${d.title}`)
      );
  }

  if (dryRun) {
    console.log("\n(dry-run) catalogue non modifié.");
    return;
  }

  if (changed === 0) {
    console.log("\nRien à écrire, catalogue identique.");
    return;
  }

  fs.writeFileSync(KNOWN_FILE, JSON.stringify(tracks, null, 2));
  console.log(`\n✓ ${KNOWN_FILE} mis à jour : ${changed} popularity refreshes.`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
