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
import { normalize, primaryArtist } from "./track-identity.js";

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

/**
 * Build a Map<normalised primary artist, { genres, source }> from the
 * catalog. Used to short-circuit the API cascade when we already know
 * an artist's genres from a previous enrichment — typically the case
 * after the first run: most multi-artist djay tracks share their
 * primary artist with an existing single-artist catalog entry.
 *
 * Songstats spend reduction is the whole point. Once "Camila Cabello"
 * is in the catalog with genres, every future track of hers — solo or
 * collab — gets her genres for free.
 */
export function buildArtistGenresCache(catalog) {
  const cache = new Map();
  for (const t of catalog) {
    if (!t.genres?.length || !t.artist) continue;
    const key = normalize(primaryArtist(t.artist));
    if (!key) continue;
    // Don't overwrite. The first hit wins — usually fine, and avoids
    // making the cache depend on catalog ordering.
    if (!cache.has(key)) {
      cache.set(key, { genres: t.genres, source: t.genresSource || t.source || "catalog" });
    }
  }
  return cache;
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
  // Use the primary artist — getsongbpm doesn't understand
  // comma-separated multi-artist strings and silently returns nothing.
  const lookup = `song:${cleanForQuery(title)} artist:${primaryArtist(cleanForQuery(artist))}`;
  const url =
    `https://api.getsong.co/search/?api_key=${GETSONGBPM_API_KEY}` +
    `&type=both&lookup=${encodeURIComponent(lookup)}&limit=3`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const best = (data.search || [])[0];
  return best?.artist?.genres?.length ? best.artist.genres : null;
}

// (Spotify artist search USED to live here as a free fallback before
// Songstats, but as of 2024-2025 the /v1/search?type=artist endpoint
// returns empty `genres` arrays for the same client-credentials reason
// /v1/artists/{id} returns 403 — Spotify has been progressively
// stripping genre data from our access tier. So it's no longer worth
// the round-trip. We jump straight from getsongbpm to Songstats.)

// ReccoBeats key codes: pitch class 0-11 (C=0, …, B=11) + mode (0=minor,
// 1=major). Converted to Camelot Wheel notation (1A-12B). Same mapping
// Mixed In Key uses. Used by buildNewTrack so iOS "Ajouter au catalogue"
// gets an immediately-usable Camelot key.
const RECCOBEATS_KEY_TO_CAMELOT = {
  "0_1": "8B",  "0_0": "5A",
  "1_1": "3B",  "1_0": "12A",
  "2_1": "10B", "2_0": "7A",
  "3_1": "5B",  "3_0": "2A",
  "4_1": "12B", "4_0": "9A",
  "5_1": "7B",  "5_0": "4A",
  "6_1": "2B",  "6_0": "11A",
  "7_1": "9B",  "7_0": "6A",
  "8_1": "4B",  "8_0": "1A",
  "9_1": "11B", "9_0": "8A",
  "10_1": "6B", "10_0": "3A",
  "11_1": "1B", "11_0": "10A",
};

function reccobeatsKeyToCamelot(key, mode) {
  if (key == null || mode == null || key < 0 || key > 11) return null;
  return RECCOBEATS_KEY_TO_CAMELOT[`${key}_${mode}`] || null;
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
 * Build a brand-new catalog entry from just (artist, title). Used by
 * /api/add-track when the iOS app surfaces a Shazam match that isn't in
 * the catalogue yet. Difference vs enrichTrack: we have NO BPM/key going
 * in, so we use ReccoBeats audio-features to source them. Returns null
 * if Spotify can't find the track at all (we need its spotifyId for the
 * downstream ReccoBeats lookups) OR if no BPM/key could be resolved
 * (without those the entry is useless for matching).
 */
export async function buildNewTrack(artist, title) {
  const token = await getSpotifyToken();
  if (!token) return null;

  // 1. Spotify search — must hit for the rest of the cascade to work
  const sp = await spotifySearchTrack(token, artist, title);
  if (!sp?.id) return null;

  const entry = {
    artist,                                            // preserve caller string
    title,                                             // (Shazam-style phrasing)
    spotifyId: sp.id,
    album: sp.album?.name || null,
    year: sp.album?.release_date?.slice(0, 4) || null,
    image: sp.album?.images?.[0]?.url || null,
    source: "ios_added",
  };

  // 2. ReccoBeats: popularity, danceability, BPM, key
  try {
    const lookup = await reccobeatsLookup(sp.id);
    if (lookup) {
      if (lookup.popularity != null) entry.popularity = lookup.popularity;
      const feat = await reccobeatsAudioFeatures(lookup.rbId);
      if (feat) {
        if (feat.tempo) {
          entry.bpm = Math.round(feat.tempo);
          entry.bpmSource = "reccobeats";
        }
        if (feat.key != null && feat.mode != null) {
          const cam = reccobeatsKeyToCamelot(feat.key, feat.mode);
          if (cam) {
            entry.key = cam;
            entry.keySource = "reccobeats";
          }
        }
        if (feat.danceability != null) {
          entry.danceability = feat.danceability;
          entry.danceabilitySource = "reccobeats";
        }
      }
    }
  } catch { /* best-effort */ }

  // 3. Genres: getsongbpm first, songstats fallback
  try {
    const g = await getsongbpmGenres(artist, title);
    if (g?.length) {
      entry.genres = g;
      entry.genresSource = "getsongbpm";
    }
  } catch {
    // best-effort
  }
  if (!entry.genres?.length && entry.spotifyId) {
    try {
      const g = await songstatsGenres(entry);
      if (g?.length) {
        entry.genres = g;
        entry.genresSource = "songstats";
      }
    } catch {
      // best-effort
    }
  }

  // Required for scoring : without BPM + key the entry can't seed anything
  if (!entry.bpm || !entry.key) return null;
  return entry;
}

/**
 * Enrich a track { artist, title, bpm, key } in-place with whatever
 * metadata the cascade of sources can resolve. Returns the same object.
 */
export async function enrichTrack(track, opts = {}) {
  const throttle = opts.throttleMs ?? 200;
  const artistGenresCache = opts.artistGenresCache;

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

  // 3. Local artist-genres cache (free, instant). Most multi-artist
  // tracks djay imports share their primary artist with a single-artist
  // catalog entry that was already enriched in a prior run — so we
  // skip the entire API cascade.
  let resolvedGenres = null;
  let genresSource = null;
  if (artistGenresCache) {
    const cached = artistGenresCache.get(normalize(primaryArtist(track.artist)));
    if (cached?.genres?.length) {
      resolvedGenres = cached.genres;
      genresSource = `cached:${cached.source}`;
    }
  }

  // 4. getsongbpm → genres (free; queried with primaryArtist so the
  // multi-artist djay strings actually resolve)
  if (!resolvedGenres) {
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
  }

  // 5. Songstats fallback for genres (PAID, ~0.01 € per call). Only
  // reached when the cache and getsongbpm both came back empty.
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
    // Feed the result back into the live cache so the very next track
    // for the same primary artist in this run gets it for free, even if
    // the first hit had to pay Songstats.
    if (artistGenresCache) {
      const key = normalize(primaryArtist(track.artist));
      if (key && !artistGenresCache.has(key)) {
        artistGenresCache.set(key, { genres: resolvedGenres, source: genresSource });
      }
    }
  }

  return track;
}
