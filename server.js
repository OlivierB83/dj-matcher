import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import {
  canonicalKey,
  primaryArtist,
  coreTitle,
  stripTrunc,
  unparenthesizeVersionMeta,
} from "./track-identity.js";
import { scoreTrack, computeCompat } from "./scoring.js";
import { buildNewTrack } from "./djay-enrich.js";

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

// Token-level helpers used by the /api/suggestions fuzzy seed lookup.
// Unlike normalize() above, tokensOf KEEPS the parenthesised content
// and tokenises everything, so "Prayer In C (Robin Schulz Remix - Radio
// Edit)" and "Prayer In C - Robin Schulz Remix - Radio Edit" produce
// the same token set.
function tokensOf(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((x) => x.length > 0);
}

// Returns true iff the artist token sets of two records look like the
// same group. Either set has to be a non-trivial (>= 2 tokens) subset
// of the other \u2014 guards against accidental matches on common single
// words like "DJ", "the", or "feat".
function artistTokensCompatible(a, b) {
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  if (small.size < 2) return false;
  for (const x of small) if (!large.has(x)) return false;
  return true;
}

// Title tokens after stripping cosmetic version metadata (Radio Edit,
// (Robin Schulz Remix - Radio Edit), etc.) \u2014 so "Fade Out Lines (Radio
// Edit)" and "Fade Out Lines - The Avener Rework" can be compared on
// their core "Fade Out Lines" content. Catalog-side titles that retain
// a named remix ("- Robin Schulz Remix") keep those tokens.
function titleTokensCanon(title) {
  return new Set(tokensOf(coreTitle(stripTrunc(unparenthesizeVersionMeta(title)))));
}

// Same subset-in-either-direction logic as artistTokensCompatible but
// for titles. Min 2 tokens to avoid one-word matches like "Hello"
// pulling in every "Hello (Live)" / "Hello (Demo)" variant.
function titleTokensCompatible(a, b) {
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  if (small.size < 2) return false;
  for (const x of small) if (!large.has(x)) return false;
  return true;
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
  //   1. Canonical key — strips "- Radio Edit", "(feat. X)", and
  //      "(Robin Schulz Remix - Radio Edit)"-style parens via
  //      unparenthesizeVersionMeta. Covers most djay/Spotify aligned
  //      catalog matches.
  //   2. Exact normalised compare — server.js's normalize strips parens,
  //      feat, version cues; same logic /api/enrich uses.
  //   3. Primary artist + normalised title — built for ShazamKit, which
  //      returns "Jungeli, Imen Es & Alonzo — Petit génie (feat. ...)"
  //      while the catalog stores all collaborators in the artist field.
  //   4. Token-set comparison — same idea as #3 but tolerates "and" vs
  //      "&" and varying numbers of collaborators. Built for the
  //      "Lilly Wood & The Prick — Prayer In C (Robin Schulz Remix - Radio
  //      Edit)" case vs catalog "Lilly Wood and The Prick, Robin Schulz —
  //      Prayer In C - Robin Schulz Remix - Radio Edit". Title tokens
  //      must be equal; artist tokens must be a non-trivial (>=2 tokens)
  //      subset in either direction.
  const seedPrimary = normalize(primaryArtist(rawArtist));
  const seedTitleCanon = titleTokensCanon(rawTitle);
  const seedArtistTokens = new Set(tokensOf(rawArtist));

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
    ) ||
    tracks.find((t) => {
      const catTitleCanon = titleTokensCanon(t.title);
      if (!titleTokensCompatible(catTitleCanon, seedTitleCanon)) return false;
      const catArtistTokens = new Set(tokensOf(t.artist));
      return artistTokensCompatible(seedArtistTokens, catArtistTokens);
    });

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

/**
 * POST /api/add-track  body: { artist, title }
 *
 * Built for the iOS app: when ShazamKit recognises a track that's not in
 * the catalogue, the user can tap "Ajouter au catalogue" to enrich and
 * persist it on the fly. Cascade is in djay-enrich.js#buildNewTrack:
 *   Spotify search → spotifyId, album, year, image
 *   ReccoBeats     → popularity, danceability, BPM, Camelot key
 *   getsongbpm     → genres
 *   songstats      → genres fallback
 *
 * Returns the same shape as /api/suggestions so iOS can transition
 * directly to the result screen in a single round-trip.
 *
 * 200 found: { current, suggestions: [...] }
 * 409 already in catalog       — returns the existing entry as `current`
 * 422 not enough metadata      — Spotify miss, or no BPM/key resolvable
 *
 * Persistence caveat: writes to knownTracks.json on the Render instance.
 * That filesystem survives between requests but is wiped on every
 * redeploy. To make adds truly persistent we'd need a Postgres or an
 * auto-commit-to-GitHub flow — noted but not implemented yet.
 */
app.post("/api/add-track", async (req, res) => {
  const rawArtist = req.body?.artist || "";
  const rawTitle = req.body?.title || "";
  if (!rawArtist || !rawTitle) {
    return res.status(400).json({
      found: false,
      message: "Paramètres requis : artist, title",
    });
  }

  const tracks = readKnownTracks();
  const seedCanon = canonicalKey(rawArtist, rawTitle);

  // If already in catalog (the canonical / fuzzy lookups in /api/suggestions
  // would have caught it normally — but we double-check here in case the
  // iOS app misroutes), just return the existing entry + suggestions.
  const existing = tracks.find(
    (t) => canonicalKey(t.artist, t.title) === seedCanon
  );
  if (existing) {
    if (!existing.bpm || !existing.key) {
      return res.status(422).json({
        found: false,
        message: `"${existing.artist} — ${existing.title}" est déjà au catalogue mais sans BPM/clé enrichis.`,
      });
    }
    const sugg = scoreAndPickSuggestions(tracks, existing, 30);
    return res.status(200).json({
      found: true,
      alreadyExisted: true,
      current: publicEntry(existing),
      suggestions: sugg,
    });
  }

  let entry;
  try {
    entry = await buildNewTrack(rawArtist, rawTitle);
  } catch (e) {
    return res.status(500).json({
      found: false,
      message: `Erreur d'enrichissement : ${e.message}`,
    });
  }

  if (!entry) {
    return res.status(422).json({
      found: false,
      message: `Impossible d'enrichir ce titre (Spotify n'a pas trouvé ou aucune source n'a remonté BPM + clé).`,
    });
  }

  tracks.push(entry);
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(tracks, null, 2));
  } catch (e) {
    return res.status(500).json({
      found: false,
      message: `Erreur d'écriture catalogue : ${e.message}`,
    });
  }

  const sugg = scoreAndPickSuggestions(tracks, entry, 30);
  res.status(200).json({
    found: true,
    alreadyExisted: false,
    current: publicEntry(entry),
    suggestions: sugg,
  });
});

// Strip internal bookkeeping fields (e.g. `_idx` that leaked into ~100
// catalog entries from an old dedup bug) before responding to clients.
function publicEntry(entry) {
  // eslint-disable-next-line no-unused-vars
  const { _idx: _ignored, ...rest } = entry;
  return rest;
}

// Helper extracted so /api/add-track can scaffold its response the same
// way /api/suggestions does.
function scoreAndPickSuggestions(tracks, current, limit) {
  const currentCanon = canonicalKey(current.artist, current.title);
  return tracks
    .filter((t) => t.bpm && t.key)
    .filter((t) => canonicalKey(t.artist, t.title) !== currentCanon)
    .map((t) => {
      const s = scoreTrack(current, t);
      return { ...publicEntry(s), compat: computeCompat(current, t) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

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