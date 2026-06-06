import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { canonicalKey, primaryArtist } from "./track-identity.js";
import { scoreTrack, computeCompat } from "./scoring.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = "./knownTracks.json";
const TOKEN_FILE = "./.spotify-token.json";

let spotifyAppToken = null;
let spotifyAppTokenExpires = 0;
let spotifyUserToken = null;
let spotifyUserTokenExpires = 0;
let spotifyUserRefreshToken = null;

function readKnownTracks() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function loadSpotifyUserTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    spotifyUserToken = data.access_token || null;
    spotifyUserTokenExpires = data.expires_at || 0;
    spotifyUserRefreshToken = data.refresh_token || null;
  } catch (err) {
    console.error("Erreur lecture token Spotify :", err.message);
  }
}

function saveSpotifyUserTokens() {
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        access_token: spotifyUserToken,
        expires_at: spotifyUserTokenExpires,
        refresh_token: spotifyUserRefreshToken,
      },
      null,
      2
    )
  );
}

async function refreshSpotifyUserToken() {
  if (!spotifyUserRefreshToken) return null;

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: spotifyUserRefreshToken,
    }),
  });

  const data = await response.json();

  if (!data.access_token) {
    console.error("Échec refresh token Spotify :", data);
    return null;
  }

  spotifyUserToken = data.access_token;
  spotifyUserTokenExpires = Date.now() + data.expires_in * 1000 - 60000;

  if (data.refresh_token) {
    spotifyUserRefreshToken = data.refresh_token;
  }

  saveSpotifyUserTokens();
  return spotifyUserToken;
}

async function getSpotifyUserToken() {
  if (spotifyUserToken && Date.now() < spotifyUserTokenExpires) {
    return spotifyUserToken;
  }

  return await refreshSpotifyUserToken();
}

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/feat\..*/gi, "")
    .replace(/ft\..*/gi, "")
    .replace(/with .*/gi, "")
    .replace(/- remix.*/gi, "")
    .replace(/- edit.*/gi, "")
    .replace(/- radio edit.*/gi, "")
    .replace(/- from .*/gi, "")
    .replace(/version.*/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getSpotifyAppToken() {
  if (spotifyAppToken && Date.now() < spotifyAppTokenExpires) {
    return spotifyAppToken;
  }

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();

  spotifyAppToken = data.access_token;
  spotifyAppTokenExpires = Date.now() + data.expires_in * 1000 - 60000;

  return spotifyAppToken;
}

app.get("/login", (req, res) => {
  const scope = "playlist-read-private playlist-read-collaborative";

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  if (req.query.error) {
    return res.status(400).send(`<h1>Erreur Spotify OAuth ❌</h1><p>${req.query.error}</p>`);
  }

  const code = req.query.code;

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    }),
  });

  const data = await response.json();

  if (!data.access_token) {
    return res.status(400).send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
  }

  spotifyUserToken = data.access_token;
  spotifyUserTokenExpires = Date.now() + data.expires_in * 1000 - 60000;
  spotifyUserRefreshToken = data.refresh_token || spotifyUserRefreshToken;
  saveSpotifyUserTokens();

  res.send(`
    <h1>DJ Matcher</h1>
    <p>Connexion Spotify réussie ✅</p>
    <p>Tu peux revenir dans le terminal.</p>
  `);
});

app.get("/api/search", async (req, res) => {
  const q = req.query.q || "";
  const token = await getSpotifyAppToken();

  const response = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const data = await response.json();
  res.json(data);
});

app.get("/api/known-tracks", (req, res) => {
  res.json(readKnownTracks());
});

app.get("/api/enrich", async (req, res) => {
  const rawArtist = req.query.artist || "";
  const rawTitle = req.query.title || "";
  const artist = normalize(rawArtist);
  const title = normalize(rawTitle);
  const canonQuery = canonicalKey(rawArtist, rawTitle);

  const tracks = readKnownTracks();

  // Try exact match first (handles the case where the Spotify title has
  // a real distinguishing suffix that the catalog also stores, like a
  // proper named remix).
  let localMatch = tracks.find(
    (track) =>
      normalize(track.artist) === artist &&
      normalize(track.title) === title
  );

  // Fall back to canonical-key match: post-dedup the catalog only stores
  // "Ça m'énerve", but the Spotify result coming through here may still
  // say "Ça m'énerve - Radio Edit". Both should resolve to the canonical
  // entry. canonicalKey strips cosmetic version suffixes ("- Radio Edit",
  // "- Extended Mix", "- Remastered YYYY", etc.) but preserves named
  // remixes.
  if (!localMatch) {
    localMatch = tracks.find(
      (track) => canonicalKey(track.artist, track.title) === canonQuery
    );
  }

  if (localMatch) {
    return res.json({
      found: true,
      source: "local",
      ...localMatch,
    });
  }

  res.json({
    found: false,
    source: "none",
    message: "Titre absent du catalogue local",
  });
});

/**
 * GET /api/suggestions?artist=X&title=Y[&limit=10]
 *
 * Built for the iOS app: pass any (artist, title) — typically what
 * ShazamKit just recognised — and get back the scored top-N
 * compatible tracks from the local catalog, identical to what the web
 * UI would compute. The shared scoring.js means the iOS results match
 * the web results to the point.
 *
 * Response shape:
 *   { found: true,
 *     current: { ...the catalog entry that matched the seed... },
 *     suggestions: [
 *       { ...catalog entry, score, camelot, compat: { bpm, key, style, dance } }
 *     ]
 *   }
 *
 * Seed lookup uses canonicalKey first (suffix-stripped, so "X — Y" and
 * "X — Y - Radio Edit" land on the same catalog entry), then a plain
 * normalised compare as a fallback. Identical priority order to
 * /api/enrich.
 *
 * Candidates with no BPM or no key are excluded — they can't be scored
 * meaningfully. The seed itself is also excluded from its own
 * suggestion list.
 */
app.get("/api/suggestions", (req, res) => {
  const rawArtist = req.query.artist || "";
  const rawTitle = req.query.title || "";

  if (!rawArtist || !rawTitle) {
    return res.status(400).json({
      found: false,
      message: "Paramètres requis : artist et title",
    });
  }

  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "10", 10) || 10));
  const tracks = readKnownTracks();

  const seedCanon = canonicalKey(rawArtist, rawTitle);
  const normArtist = normalize(rawArtist);
  const normTitle = normalize(rawTitle);

  // Seed lookup, progressively fuzzier.
  //   1. Canonical key (suffix-stripped: "- Radio Edit", "(feat. X)", etc.
  //      Handles djay/Spotify catalog matches.)
  //   2. Exact normalised compare (server.js's normalize strips parens,
  //      feat, version cues; same logic /api/enrich uses.)
  //   3. Primary artist + normalised title. Built for ShazamKit, which
  //      returns "Jungeli, Imen Es & Alonzo — Petit génie (feat. ...)"
  //      while the catalog stores "Jungeli, Imen Es, Alonzo, Lossa,
  //      Abou Debeing — Petit génie" — strings differ but the primary
  //      artist + the song title agree, and that's enough to match.
  const seedPrimary = normalize(primaryArtist(rawArtist));
  let current =
    tracks.find((t) => canonicalKey(t.artist, t.title) === seedCanon) ||
    tracks.find(
      (t) =>
        normalize(t.artist) === normArtist && normalize(t.title) === normTitle
    ) ||
    tracks.find(
      (t) =>
        normalize(primaryArtist(t.artist)) === seedPrimary &&
        normalize(t.title) === normTitle
    );

  if (!current) {
    return res.status(404).json({
      found: false,
      message: `Aucune entrée catalogue pour "${rawArtist} — ${rawTitle}".`,
    });
  }

  if (!current.bpm || !current.key) {
    return res.status(422).json({
      found: false,
      message: `Le titre "${current.artist} — ${current.title}" existe au catalogue mais n'a pas de BPM/clé enrichis.`,
    });
  }

  const currentCanon = canonicalKey(current.artist, current.title);

  // Internal bookkeeping fields that should never leak to clients.
  // `_idx` slipped into ~100 catalog entries from an old dedup bug; we
  // strip it defensively here so the iOS app gets a clean payload
  // regardless of catalog cleanliness.
  function publicEntry(entry) {
    // eslint-disable-next-line no-unused-vars
    const { _idx: _ignored, ...rest } = entry;
    return rest;
  }

  const scored = tracks
    .filter((t) => t.bpm && t.key)
    .filter((t) => canonicalKey(t.artist, t.title) !== currentCanon)
    .map((t) => {
      const s = scoreTrack(current, t);
      return {
        ...publicEntry(s),
        compat: computeCompat(current, t),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  res.json({
    found: true,
    current: publicEntry(current),
    suggestions: scored,
  });
});

app.get("/api/import-playlist/:playlistId", async (req, res) => {
  const userToken = await getSpotifyUserToken();

  if (!userToken) {
    return res.status(401).json({
      error: "Pas connecté à Spotify. Va sur /login",
    });
  }

  const playlistId = req.params.playlistId;

  let offset = 0;
  const limit = 100;

  const importedTracks = [];
  let spotifyTotal = null;
  let rawItemsTotal = 0;

  while (true) {
    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&additional_types=track&market=FR`,
      {
        headers: { Authorization: `Bearer ${userToken}` },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    spotifyTotal ??= data.total;
    const items = data.items || [];
    rawItemsTotal += items.length;

    for (const item of items) {
      const track = item.track || item.item;

      if (!track || track.type !== "track") continue;

      importedTracks.push({
        title: track.name,
        artist: track.artists?.[0]?.name,
        album: track.album?.name,
        year: track.album?.release_date?.slice(0, 4),
        spotifyId: track.id,
        isrc: track.external_ids?.isrc,
        image: track.album?.images?.[2]?.url || track.album?.images?.[0]?.url,
      });
    }

    if (!data.next) break;
    offset += limit;
  }

  fs.writeFileSync("./catalog-input.json", JSON.stringify(importedTracks, null, 2));

  res.json({
    success: true,
    imported: importedTracks.length,
    debug: {
      playlistId,
      spotifyTotal,
      rawItemsTotal,
    },
  });
});

app.get("/api/local-search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.json([]);
    }

    const normalizeText = (text) =>
      String(text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    const terms = normalizeText(q)
      .split(" ")
      .filter(Boolean);

    const tracks = readKnownTracks();

    const results = tracks
      .filter((track) => {
        const haystack = normalizeText(
          `${track.title || ""} ${track.artist || ""} ${track.album || ""}`
        );

        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, 20);

    res.json(results);
  } catch (err) {
    console.error("Erreur /api/local-search :", err);
    res.status(500).json({ error: "Erreur recherche locale" });
  }
});

const PORT = process.env.PORT || 3001;

loadSpotifyUserTokens();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});