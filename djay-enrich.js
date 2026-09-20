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
    // Identifiants Spotify connus de Songstats : permettent d'interroger
    // ReccoBeats (audio-features) sans aucun appel à l'API Spotify.
    spotifyIds: (info.links || []).filter((l) => l.source === "spotify" && l.external_id).map((l) => l.external_id),
  };
}

// ReccoBeats key codes: pitch class 0-11 (C=0, …, B=11) + mode (0=minor,
// 1=major) → Camelot (1A-12B), même correspondance que Mixed In Key.
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

/** Tempo / clé / dansabilité ReccoBeats pour un identifiant Spotify (gratuit, sans API Spotify). */
async function reccobeatsFeaturesForSpotifyId(spotifyId) {
  const lookup = await reccobeatsLookup(spotifyId);
  if (!lookup?.rbId) return null;
  const feat = await reccobeatsAudioFeatures(lookup.rbId);
  if (!feat) return null;
  return {
    bpm: feat.tempo ? Math.round(feat.tempo) : null,
    key: reccobeatsKeyToCamelot(feat.key, feat.mode),
    danceability: feat.danceability ?? null,
    popularity: lookup.popularity ?? null,
  };
}

/** Valide une clé saisie ("8A", "Am", "F#") → Camelot, ou null. */
export function parseKeyInput(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (/^(1[0-2]|[1-9])[AB]$/.test(v)) return v;
  return toCamelot(String(raw || "").trim()) || null;
}

/**
 * Build a brand-new catalog entry from just (artist, title). Used by
 * /api/add-track when the iOS app surfaces a Shazam match that isn't in
 * the catalogue yet. Zéro Spotify :
 *   1. Deezer      → deezerId, isrc, album, year, cover, popularity (rang), BPM éventuel
 *   2. getsongbpm  → BPM + clé (+ genres)
 *   3. Songstats   → BPM + clé + genres (payant), par ISRC ; ses liens Spotify
 *      alimentent 4.
 *   4. ReccoBeats  → tempo + clé + dansabilité via l'identifiant Spotify
 *      fourni par Songstats (aucun appel à l'API Spotify)
 * `manual` = { bpm, key } saisis par le DJ dans l'app quand aucune source
 * n'a la réponse : ils priment et évitent les appels payants.
 * Returns null if Deezer can't find the track (we need its ISRC / metadata)
 * OR if no BPM/key could be resolved (without those the entry is useless
 * for matching).
 */
export async function buildNewTrack(artist, title, manual = {}) {
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

  // 0. Saisie manuelle du DJ : prime sur tout
  if (manual.bpm) { entry.bpm = manual.bpm; entry.bpmSource = "manual"; }
  if (manual.key) { entry.key = manual.key; entry.keySource = "manual"; }

  // 2. getsongbpm : BPM + clé (notation traditionnelle → Camelot) + genres
  try {
    const hit = await getsongbpmHit(artist, title);
    if (hit) {
      if (!entry.bpm && hit.tempo) {
        const v = normalizeBpmKeep(hit.tempo);
        if (v) { entry.bpm = v; entry.bpmSource = "getsongbpm"; }
      }
      if (!entry.key && hit.key_of) {
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
  let spotifyIds = [];
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
        spotifyIds = info.spotifyIds || [];
      }
    } catch { /* best-effort */ }
  }

  // 4. ReccoBeats via les identifiants Spotify de Songstats : les titres
  //    trop récents pour getsongbpm et sans analyse Songstats (ex. sorties
  //    de l'été 2026) ont en général déjà leurs audio-features ici.
  if (!entry.bpm || !entry.key) {
    for (const sid of spotifyIds.slice(0, 3)) {
      try {
        const f = await reccobeatsFeaturesForSpotifyId(sid);
        if (!f) continue;
        if (!entry.bpm && f.bpm) { entry.bpm = f.bpm; entry.bpmSource = "reccobeats"; }
        if (!entry.key && f.key) { entry.key = f.key; entry.keySource = "reccobeats"; }
        if (entry.danceability == null && f.danceability != null) {
          entry.danceability = f.danceability;
          entry.danceabilitySource = "reccobeats";
        }
        if (entry.bpm && entry.key) break;
      } catch { /* best-effort */ }
    }
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
