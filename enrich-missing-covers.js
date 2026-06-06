/**
 * enrich-missing-covers.js
 *
 * Backfill spotifyId + image + album + year for catalog entries that
 * don't have a spotifyId yet. ~1900 entries in this state, mostly djay
 * imports where the initial Spotify search missed (typically because
 * the artist string is "ArtistA, ArtistB, ArtistC" and Spotify's
 * strict query parser doesn't match).
 *
 * Strategy per entry, in order until something hits:
 *   1. track:"Title" artist:"FirstArtist"      (strict, primary artist)
 *   2. track:"Title" artist:"FullArtist"       (strict, full artist string)
 *   3. "Title FirstArtist"                      (free text, primary)
 *   4. "Title"                                  (free text, title only)
 *
 * Throttled at 200 ms/request to stay well under Spotify rate limits.
 * Writes back to knownTracks.json every 25 entries so a Ctrl-C only
 * loses a small batch.
 *
 *   node enrich-missing-covers.js          # preview, 50 entries
 *   node enrich-missing-covers.js --commit # process up to 500 entries
 *   node enrich-missing-covers.js --all    # process everything (~7 min)
 */

import "dotenv/config";
import fs from "fs";
import { primaryArtist } from "./track-identity.js";

const KNOWN_FILE = "./knownTracks.json";
const CID = process.env.SPOTIFY_CLIENT_ID;
const CSECRET = process.env.SPOTIFY_CLIENT_SECRET;
const THROTTLE_MS = 200;
const PERSIST_EVERY = 25;

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const all = args.includes("--all");
const MAX = all ? Infinity : (commit ? 500 : 50);

if (!CID || !CSECRET) {
  console.error("❌ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET manquants dans .env");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _token = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${CID}:${CSECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Token: HTTP ${r.status}`);
  const data = await r.json();
  _token = data.access_token;
  _tokenExp = Date.now() + data.expires_in * 1000;
  return _token;
}

function cleanForQuery(s) {
  return String(s || "")
    .replace(/\s*[.…]{1,}$/u, "")
    .replace(/\(feat\..*?\)/gi, "")
    .replace(/\(ft\..*?\)/gi, "")
    .replace(/"/g, "")
    .trim();
}

async function spotifyQuery(token, query) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=3`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const data = await r.json();
  return data.tracks?.items?.[0] || null;
}

async function findSpotifyTrack(token, artist, title) {
  const cleanTitle = cleanForQuery(title);
  const cleanArtist = cleanForQuery(artist);
  const primary = primaryArtist(cleanArtist);

  const queries = [
    `track:"${cleanTitle}" artist:"${primary}"`,
    `track:"${cleanTitle}" artist:"${cleanArtist}"`,
    `${cleanTitle} ${primary}`,
    `${cleanTitle}`,
  ];
  for (const q of queries) {
    const hit = await spotifyQuery(token, q);
    if (hit?.id) return { hit, query: q };
    await sleep(THROTTLE_MS / 4);
  }
  return null;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
  const eligible = catalog
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.spotifyId && t.artist && t.title);

  console.log(`Total catalogue          : ${catalog.length}`);
  console.log(`Sans spotifyId / image   : ${eligible.length}`);
  console.log(`Limite ce run            : ${MAX === Infinity ? "tout" : MAX}`);
  console.log(`Throttle                 : ${THROTTLE_MS} ms`);
  console.log("");

  if (!commit && !all) {
    console.log("Mode preview : 50 premières entrées. --commit pour 500, --all pour tout.");
    console.log("");
  }

  const token = await getToken();
  console.log("✓ Spotify token obtenu\n");

  const stats = { found: 0, missed: 0, errored: 0 };
  const sample = [];
  let processed = 0;

  for (const { t, i } of eligible) {
    if (processed >= MAX) break;
    processed++;

    try {
      const result = await findSpotifyTrack(token, t.artist, t.title);
      if (result?.hit) {
        const hit = result.hit;
        catalog[i] = {
          ...t,
          spotifyId: hit.id,
          album: t.album || hit.album?.name || null,
          year: t.year || hit.album?.release_date?.slice(0, 4) || null,
          image: t.image || hit.album?.images?.[2]?.url || hit.album?.images?.[0]?.url || null,
        };
        stats.found++;
        if (sample.length < 8) {
          sample.push({ artist: t.artist, title: t.title, found: `${hit.artists?.[0]?.name} — ${hit.name}` });
        }
      } else {
        stats.missed++;
      }
    } catch (e) {
      stats.errored++;
      console.error(`   ⚠️  ${t.artist} — ${t.title} : ${e.message}`);
    }

    if (processed % PERSIST_EVERY === 0 || processed === eligible.length) {
      if (commit || all) {
        fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
      }
      console.log(`[${String(processed).padStart(4)}/${eligible.length}] found=${stats.found} · missed=${stats.missed} · errored=${stats.errored}`);
    }

    await sleep(THROTTLE_MS);
  }

  if (commit || all) {
    fs.writeFileSync(KNOWN_FILE, JSON.stringify(catalog, null, 2));
  }

  console.log("");
  console.log("=== Bilan ===");
  console.log(`Traités        : ${processed}`);
  console.log(`Trouvés        : ${stats.found} (${Math.round(100 * stats.found / processed)}%)`);
  console.log(`Non trouvés    : ${stats.missed}`);
  console.log(`Erreurs        : ${stats.errored}`);
  if (sample.length) {
    console.log("\nÉchantillon (8 premières trouvailles) :");
    sample.forEach((s) => console.log(`  ${s.artist} — ${s.title}  →  ${s.found}`));
  }
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
