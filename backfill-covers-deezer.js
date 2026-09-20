/**
 * backfill-covers-deezer.js
 *
 * Complément de migrate-covers-itunes.js : pour les entrées que l'API iTunes
 * n'a pas trouvées (pochette encore sur le CDN Spotify, ou sans pochette),
 * récupère la pochette d'album chez Deezer via le deezerId déjà résolu par
 * refresh-popularity-deezer.js. Objectif : zéro URL i.scdn.co au runtime.
 *
 * Ne touche que `image` et `imageSource` ("deezer"). Les entrées déjà en
 * imageSource "itunes" sont ignorées ; celles sans deezerId restent telles quelles.
 *
 *   node backfill-covers-deezer.js            # preview, rien n'est écrit
 *   node backfill-covers-deezer.js --commit   # écrit knownTracks.json
 */

import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const THROTTLE_MS = 120;
const commit = process.argv.includes("--commit");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deezerTrack(id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`https://api.deezer.com/track/${id}`).catch(() => null);
    if (!r) { await sleep(2000); continue; }
    const j = await r.json().catch(() => null);
    if (j?.error?.code === 4) { await sleep(5000); continue; }
    return j?.error ? null : j;
  }
  return null;
}

async function main() {
  const tracks = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const todo = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.imageSource !== "itunes" && t.imageSource !== "deezer" && t.deezerId);
  console.log(`Catalogue : ${tracks.length} · à compléter via Deezer : ${todo.length}${commit ? "" : " (preview)"}\n`);

  let found = 0, missed = 0;
  for (const { t, i } of todo) {
    const d = await deezerTrack(t.deezerId);
    const url = d?.album?.cover_xl || d?.album?.cover_big || null;
    if (url) {
      tracks[i] = { ...t, image: url, imageSource: "deezer", album: t.album || d.album?.title || null };
      found++;
    } else {
      missed++;
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`Pochettes Deezer : ${found} · sans pochette : ${missed}`);
  if (!commit) { console.log("(preview) rien n'est écrit. --commit pour appliquer."); return; }
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(tracks, null, 2));
  const scdn = tracks.filter((x) => (x.image || "").includes("scdn.co")).length;
  const none = tracks.filter((x) => !x.image).length;
  console.log(`✓ ${KNOWN_FILE} mis à jour. Reste : ${scdn} pochettes Spotify CDN, ${none} sans pochette.`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
