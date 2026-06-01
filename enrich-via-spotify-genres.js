/**
 * Replace catalog `genres` with the official Spotify artist genres.
 *
 * Spotify has deprecated /v1/tracks?ids= and /v1/artists?ids= for our app
 * credentials (both 403). We work around it by deduping the catalog by
 * artist name and doing ONE /v1/search per unique artist — search returns
 * the matching artist with its genres array directly.
 *
 *   ~700 unique artists * 150 ms throttle ≈ 2 minutes
 *
 * For each catalog row whose artist matches one we resolved, we replace
 * `genres` with Spotify's and mark `genresSource: "spotify"`. Spotify
 * "no genres" rows are left alone (we don't wipe data we already have).
 *
 * A timestamped backup is written before any mutation.
 */

import "dotenv/config";
import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const BACKUP_FILE = `./knownTracks.bak.${Date.now()}.json`;
const THROTTLE_MS = 150;

const CID = process.env.SPOTIFY_CLIENT_ID;
const CSECRET = process.env.SPOTIFY_CLIENT_SECRET;
if (!CID || !CSECRET) {
  console.error("❌ Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${CID}:${CSECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Token: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

async function searchArtist(token, name) {
  const q = encodeURIComponent(`artist:"${name}"`);
  const r = await fetch(
    `https://api.spotify.com/v1/search?q=${q}&type=artist&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.artists?.items?.[0] || null;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));

  // Dedupe by primary artist name. We use the artist string the catalog
  // already stores; for multi-artist tracks the primary one (everything
  // before the first comma / "&" / "feat") is the safest probe term.
  function primaryArtist(s) {
    return String(s || "")
      .split(/,| & |\bfeat\.?|\bft\.?|\bwith\b|\bvs\.?/i)[0]
      .trim();
  }

  const artistToTracks = new Map(); // primary artist (raw) → catalog indices
  catalog.forEach((t, i) => {
    if (!t.artist) return;
    const a = primaryArtist(t.artist);
    if (!a) return;
    if (!artistToTracks.has(a)) artistToTracks.set(a, []);
    artistToTracks.get(a).push(i);
  });

  console.log(`Total catalogue       : ${catalog.length}`);
  console.log(`Artistes uniques      : ${artistToTracks.size}`);
  console.log(`Throttle              : ${THROTTLE_MS} ms`);
  console.log(`ETA                  ≈ ${Math.round((artistToTracks.size * THROTTLE_MS) / 60000)} min\n`);

  fs.copyFileSync(KNOWN_FILE, BACKUP_FILE);
  console.log(`💾 Backup : ${BACKUP_FILE}\n`);

  const token = await getToken();
  console.log("✓ Spotify token obtenu\n");

  console.log("=== Phase 1 : recherche artistes Spotify ===");
  const artistsList = [...artistToTracks.keys()];
  const artistData = new Map(); // raw artist name → {genres, spotifyArtistId, returnedName}
  const failedSearch = [];

  for (let i = 0; i < artistsList.length; i++) {
    const name = artistsList[i];
    const found = await searchArtist(token, name);
    if (found && found.id) {
      artistData.set(name, {
        genres: found.genres || [],
        spotifyArtistId: found.id,
        returnedName: found.name,
      });
    } else {
      failedSearch.push(name);
    }
    if ((i + 1) % 50 === 0 || i === artistsList.length - 1) {
      console.log(`[search] ${i + 1}/${artistsList.length} · résolus=${artistData.size} · échecs=${failedSearch.length}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`→ ${artistData.size} artistes résolus, ${failedSearch.length} échecs\n`);

  // Phase 2: apply genres
  console.log("=== Phase 2 : application au catalogue ===");
  let replaced = 0, unchanged = 0, emptyArtist = 0, skipped = 0;
  const samples = [];

  for (const [name, indices] of artistToTracks.entries()) {
    const data = artistData.get(name);
    if (!data) { skipped += indices.length; continue; }
    if (!data.genres.length) {
      // Spotify knows the artist but lists no genres — keep what we have
      emptyArtist += indices.length;
      continue;
    }
    for (const idx of indices) {
      const t = catalog[idx];
      const before = JSON.stringify(t.genres || []);
      const after = JSON.stringify(data.genres);
      if (before === after) {
        unchanged++;
        continue;
      }
      if (samples.length < 25) {
        samples.push({
          artist: t.artist,
          title: t.title,
          before: t.genres || [],
          after: data.genres,
          returnedName: data.returnedName,
        });
      }
      catalog[idx] = { ...t, genres: data.genres, genresSource: "spotify" };
      replaced++;
    }
  }

  fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));

  console.log("");
  console.log("=== Bilan ===");
  console.log(`Genres remplacés (Spotify)        : ${replaced}`);
  console.log(`Inchangés (déjà identiques)       : ${unchanged}`);
  console.log(`Artiste connu mais 0 genre Spotify: ${emptyArtist}`);
  console.log(`Artiste non résolu                : ${skipped}`);
  console.log("");
  console.log("Échantillon (top 15) :");
  samples.slice(0, 15).forEach((s) => {
    const b = s.before.slice(0, 3).join(", ") || "—";
    const a = s.after.slice(0, 3).join(", ");
    console.log(`  [${b}] → [${a}]  ·  ${s.artist} — ${s.title}`);
  });

  if (failedSearch.length) {
    console.log(`\nÉchantillon échecs de recherche (max 10) :`);
    failedSearch.slice(0, 10).forEach((n) => console.log(`  ${n}`));
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
