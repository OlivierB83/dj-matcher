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
import { toCamelot } from "./scoring.js";

const CID = process.env.SPOTIFY_CLIENT_ID;
const CSECRET = process.env.SPOTIFY_CLIENT_SECRET;
import { findTrack as findDeezerTrack } from "./deezer.js";

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
  const primary = primaryArtist(cleanArtist);
  // Five-shot cascade : Spotify's strict track:/artist: syntax often misses
  // on obscure indie tracks even when they exist. Free-text queries find
  // a lot more, and we then pick the item whose artist matches our input
  // primary artist (normalised). Title alone is the last resort.
  const queries = [
    `track:"${cleanTitle}" artist:"${cleanArtist}"`,
    primary && primary !== cleanArtist ? `track:"${cleanTitle}" artist:"${primary}"` : null,
    `${cleanTitle} ${cleanArtist}`,
    primary && primary !== cleanArtist ? `${cleanTitle} ${primary}` : null,
    cleanTitle,
  ].filter(Boolean);

  const targetPrimary = normalize(primary);
  const targetArtist = normalize(cleanArtist);

  for (const q of queries) {
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) continue;
    const data = await r.json();
    const items = data.tracks?.items || [];
    if (!items.length) continue;
    // Look for an item whose first artist matches our input primary
    // artist. Falls back to top hit so loose searches still pick *something*.
    const best = items.find((it) => {
      const a = normalize(it.artists?.[0]?.name || "");
      return a === targetArtist || a === targetPrimary || a.startsWith(targetPrimary) || targetPrimary.startsWith(a);
    });
    if (best) return best;
  }
  // No item matched our artist on any query — return the top hit of the
  // tightest still-available query as a last shot. Worst case we add a
  // mislabeled track ; user can delete + retry.
  for (const q of queries) {
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`,
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
  const hit = await getsongbpmHit(artist, title);
  return hit?.artist?.genres?.length ? hit.artist.genres : null;
}

/** Returns the raw top hit from getsongbpm — used both for genres-only
 *  enrichment (existing flow) and for the BPM/key fallback in
 *  buildNewTrack when ReccoBeats had no audio-features for the track. */
async function getsongbpmHit(artist, title) {
  if (!GETSONGBPM_API_KEY) return null;
  const lookup = `song:${cleanForQuery(title)} artist:${primaryArtist(cleanForQuery(artist))}`;
  const url =
    `https://api.getsong.co/search/?api_key=${GETSONGBPM_API_KEY}` +
    `&type=both&lookup=${encodeURIComponent(lookup)}&limit=3`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return (data.search || [])[0] || null;
}

function normalizeBpmKeep(value) {
  const v = Number(value);
  if (!v || isNaN(v)) return null;
  return Math.round(v);
}

// (Spotify artist search USED to live here as a free fallback before
// Songstats, but as of 2024-2025 the /v1/search?type=artist endpoint
// returns empty `genres` arrays for the same client-credentials reason
// /v1/artists/{id} returns 403 — Spotify has been progressively
// stripping genre data from our access tier. So it's no longer worth
// the round-trip. We jump straight from getsongbpm to Songstats.)

async function songstatsGenres(track) {
  const info = await songstatsFullLookup(track);
  return info?.genres?.length ? info.genres : null;
}

/** Returns { genres, bpm, key (traditional, e.g. "Cm" / "F#") } from
 *  Songstats. buildNewTrack uses this as last-chance fallback for BPM/key
 *  when ReccoBeats and getsongbpm have both whiffed. PAID, so we only
 *  reach this path when we really need to. */
async function songstatsFullLookup(track) {
  if (!SONGSTATS_API_KEY || (!track.isrc && !track.spotifyId)) return null;
  // Log BEFORE the call so even network failures count.
  logSongstatsRequest(track);
  // ISRC d'abord (fourni par Deezer), spotify_track_id pour les anciennes entrées.
  const param = track.isrc
    ? `isrc=${encodeURIComponent(track.isrc)}`
    : `spotify_track_id=${encodeURIComponent(track.spotifyId)}`;
  const url = `https://api.songstats.com/enterprise/v1/tracks/info?${param}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json", apikey: SONGSTATS_API_KEY },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const info = data.track_info || {};
  const analysis = Object.fromEntries(
    (data.audio_analysis || []).map((item) => [item.key, item.value])
  );
  return {
    genres: info.genres || [],
    bpm: normalizeBpmKeep(analysis.tempo),
    keyTraditional: analysis.key || null,
  };
}

/**
 * Build a brand-new catalog entry from just (artist, title). Used by
 * /api/add-track when the iOS app surfaces a Shazam match that isn't in
 * the catalogue yet. Zéro Spotify :
 *   1. Deezer      → deezerId, isrc, album, year, cover, popularity (rang), BPM éventuel
 *   2. getsongbpm  → BPM + clé (+ genres)
 *   3. Songstats   → BPM + clé + genres, en dernier recours (payant), par ISRC
 * Returns null if Deezer can't find the track (we need its ISRC / metadata)
 * OR if no BPM/key could be resolved (without those the entry is useless
 * for matching).
 */
export async function buildNewTrack(artist, title) {
  // 1. Deezer — doit trouver le morceau pour que la suite ait un sens
  let dz;
  try { dz = await findDeezerTrack(artist, title); } catch { dz = null; }
  if (!dz) {
    console.log(`[add-track] Deezer miss for "${artist} — ${title}"`);
    return null;
  }

  const entry = {
    artist,
    title,
    deezerId: dz.deezerId,
    isrc: dz.isrc || null,
    album: dz.album || null,
    year: dz.year || null,
    image: dz.image || null,
    imageSource: dz.image ? "deezer" : undefined,
    deezerRank: dz.rank ?? null,
    popularity: dz.rank != null ? Math.max(0, Math.min(100, Math.round(dz.rank / 10000))) : null,
    popularitySource: dz.rank != null ? "deezer" : undefined,
    source: "ios_added",
  };

  // 2. getsongbpm : BPM + clé (notation traditionnelle → Camelot) + genres
  try {
    const hit = await getsongbpmHit(artist, title);
    if (hit) {
      if (hit.tempo) {
        const v = normalizeBpmKeep(hit.tempo);
        if (v) { entry.bpm = v; entry.bpmSource = "getsongbpm"; }
      }
      if (hit.key_of) {
        const cam = toCamelot(hit.key_of);
        if (cam) { entry.key = cam; entry.keySource = "getsongbpm"; }
      }
      if (hit.artist?.genres?.length) {
        entry.genres = hit.artist.genres;
        entry.genresSource = "getsongbpm";
      }
    }
  } catch { /* best-effort */ }

  // BPM Deezer en repli seulement : souvent absent (0) et moins fiable.
  if (!entry.bpm && dz.bpm) {
    entry.bpm = normalizeBpmKeep(dz.bpm);
    entry.bpmSource = "deezer";
  }

  // 3. Songstats (payant) : uniquement s'il manque encore BPM ou clé,
  //    ou les genres — et seulement avec un ISRC.
  if (entry.isrc && (!entry.bpm || !entry.key || !entry.genres?.length)) {
    try {
      const info = await songstatsFullLookup(entry);
      if (info) {
        if (!entry.bpm && info.bpm) { entry.bpm = info.bpm; entry.bpmSource = "songstats"; }
        if (!entry.key && info.keyTraditional) {
          const cam = toCamelot(info.keyTraditional);
          if (cam) { entry.key = cam; entry.keySource = "songstats"; }
        }
        if (info.genres?.length && !entry.genres?.length) {
          entry.genres = info.genres;
          entry.genresSource = "songstats";
        }
      }
    } catch { /* best-effort */ }
  }

  if (!entry.bpm || !entry.key) {
    console.log(
      `[add-track] No BPM/key for "${artist} — ${title}" (deezer ✓ bpm=${entry.bpmSource ?? "?"} key=${entry.keySource ?? "?"})`
    );
    return null;
  }

  // Pas de champs undefined dans le catalogue
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];

  console.log(
    `[add-track] OK "${artist} — ${title}" → ${entry.bpm}/${entry.key} ` +
    `(bpm=${entry.bpmSource}, key=${entry.keySource}, genres=${entry.genresSource ?? "none"})`
  );
  return entry;
}

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
