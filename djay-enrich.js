/**
 * djay-enrich.js
 *
 * Per-track enrichment used by djay-ax-import.js when committing new
 * tracks pulled from djay. Given a minimal { artist, title, bpm, key }
 * (where BPM + key are djay-confirmed and treated as ground truth),
 * this fills in the remaining catalog metadata:
 *
 *   spotifyId, album, year, image   ← Spotify /v1/search?type=track
 *   popularity, danceability        ← ReccoBeats /v1/track + /v1/audio-features
 *   genres (with genresSource)      ← getsongbpm primary, songstats fallback
 *
 * BPM and key are never touched. Everything is best-effort: if a source
 * fails for a given track we just move on; the track still gets written
 * with whatever fields we could resolve.
 *
 * Exposes async enrichTrack(track, opts) which MUTATES the passed object
 * and also returns it.
 */

import "dotenv/config";
import fs from "fs";

const CID = process.env.SPOTIFY_CLIENT_ID;
const CSECRET = process.env.SPOTIFY_CLIENT_SECRET;
const GETSONGBPM_API_KEY = process.env.GETSONGBPM_API_KEY;
const SONGSTATS_API_KEY = process.env.SONGSTATS_API_KEY;

const SONGSTATS_USAGE_LOG_FILE = "./songstats-usage-log.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors catalog-builder.js — every Songstats call is paid (~0.01 €),
// so every call gets a journal entry. `node songstats-usage-report.js`
// reads this file to show monthly + lifetime totals.
function logSongstatsRequest(track) {
  let logs = [];
  if (fs.existsSync(SONGSTATS_USAGE_LOG_FILE)) {
    const content = fs.readFileSync(SONGSTATS_USAGE_LOG_FILE, "utf8").trim();
    if (content) logs = JSON.parse(content);
  }
  const now = new Date();
  logs.push({
    date: now.toISOString(),
    month: now.toISOString().slice(0, 7),
    title: track.title,
    artist: track.artist,
    spotifyId: track.spotifyId || null,
    isrc: track.isrc || null,
    caller: "djay-enrich",
  });
  fs.writeFileSync(SONGSTATS_USAGE_LOG_FILE, JSON.stringify(logs, null, 2));
}

let _spToken = null;
let _spTokenExp = 0;

async function getSpotifyToken() {
  if (_spToken && Date.now() < _spTokenExp - 60_000) return _spToken;
  if (!CID || !CSECRET) return null;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${CID}:${CSECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) return null;
  const data = await r.json();
  _spToken = data.access_token;
  _spTokenExp = Date.now() + data.expires_in * 1000;
  return _spToken;
}

// Strip djay's truncation ellipsis and parentheticals so the Spotify
// query matches more cases.
function cleanForQuery(s) {
  return String(s || "")
    .replace(/\s*[.…]{1,}$/u, "")
    .replace(/\(feat\..*?\)/gi, "")
    .replace(/\(ft\..*?\)/gi, "")
    .replace(/"/g, "")
    .trim();
}

async function spotifySearchTrack(token, artist, title) {
  const cleanArtist = cleanForQuery(artist);
  const cleanTitle = cleanForQuery(title);
  // Two-shot: structured query first, then plain text if that misses.
  for (const q of [
    `track:"${cleanTitle}" artist:"${cleanArtist}"`,
    `${cleanTitle} ${cleanArtist}`,
  ]) {
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) continue;
    const data = await r.json();
    const hit = data.tracks?.items?.[0];
    if (hit) return hit;
  }
  return null;
}

async function reccobeatsLookup(spotifyId) {
  const r = await fetch(`https://api.reccobeats.com/v1/track?ids=${spotifyId}`);
  if (!r.ok) return null;
  const data = await r.json();
  const t = data.content?.[0];
  if (!t) return null;
  return { rbId: t.id, popularity: t.popularity ?? null };
}

async function reccobeatsAudioFeatures(rbId) {
  const r = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${rbId}`);
  if (!r.ok) return null;
  const data = await r.json();
  return data.content?.[0] || null;
}

async function getsongbpmGenres(artist, title) {
  if (!GETSONGBPM_API_KEY) return null;
  const lookup = `song:${cleanForQuery(title)} artist:${cleanForQuery(artist)}`;
  const url =
    `https://api.getsong.co/search/?api_key=${GETSONGBPM_API_KEY}` +
    `&type=both&lookup=${encodeURIComponent(lookup)}&limit=3`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const best = (data.search || [])[0];
  return best?.artist?.genres?.length ? best.artist.genres : null;
}

async function songstatsGenres(track) {
  if (!SONGSTATS_API_KEY || !track.spotifyId) return null;
  // Log BEFORE the call so even network failures count (Songstats bills
  // any request that left the wire). The journal entry is what feeds
  // `node songstats-usage-report.js`.
  logSongstatsRequest(track);
  const url =
    `https://api.songstats.com/enterprise/v1/tracks/info` +
    `?spotify_track_id=${encodeURIComponent(track.spotifyId)}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json", apikey: SONGSTATS_API_KEY },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.track_info?.genres?.length ? data.track_info.genres : null;
}

/**
 * Enrich a track { artist, title, bpm, key } in-place with whatever
 * metadata the cascade of sources can resolve. Returns the same object.
 */
export async function enrichTrack(track, opts = {}) {
  const throttle = opts.throttleMs ?? 200;

  // 1. Spotify search → spotifyId / album / year / image
  try {
    const token = await getSpotifyToken();
    if (token) {
      const found = await spotifySearchTrack(token, track.artist, track.title);
      if (found?.id) {
        track.spotifyId = found.id;
        track.album = found.album?.name || null;
        track.year = found.album?.release_date?.slice(0, 4) || null;
        track.image = found.album?.images?.[0]?.url || null;
      }
      await sleep(throttle);
    }
  } catch {
    // best-effort, ignore
  }

  // 2. ReccoBeats → popularity + danceability (needs spotifyId)
  if (track.spotifyId) {
    try {
      const lookup = await reccobeatsLookup(track.spotifyId);
      if (lookup) {
        if (lookup.popularity != null) track.popularity = lookup.popularity;
        await sleep(throttle);
        const feat = await reccobeatsAudioFeatures(lookup.rbId);
        if (feat?.danceability != null) {
          track.danceability = feat.danceability;
          track.danceabilitySource = "reccobeats";
        }
      }
      await sleep(throttle);
    } catch {
      // best-effort, ignore
    }
  }

  // 3. getsongbpm → genres
  let resolvedGenres = null;
  let genresSource = null;
  try {
    const g = await getsongbpmGenres(track.artist, track.title);
    if (g) {
      resolvedGenres = g;
      genresSource = "getsongbpm";
    }
    await sleep(throttle);
  } catch {
    // best-effort, ignore
  }

  // 4. Songstats fallback for genres (paid, only when getsongbpm misses)
  if (!resolvedGenres && track.spotifyId) {
    try {
      const g = await songstatsGenres(track);
      if (g) {
        resolvedGenres = g;
        genresSource = "songstats";
      }
      await sleep(throttle);
    } catch {
      // best-effort, ignore
    }
  }

  if (resolvedGenres) {
    track.genres = resolvedGenres;
    track.genresSource = genresSource;
  }

  return track;
}
