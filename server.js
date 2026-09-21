import express from "express";
import cors from "cors";
import compression from "compression";
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
import { buildNewTrack, parseKeyInput } from "./djay-enrich.js";
import { searchTracks, DeezerLimited } from "./deezer.js";
import * as catalog from "./catalog-store.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(compression()); // /api/known-tracks passe de 4 Mo à ~600 Ko
app.use(express.json());

const TOKEN_FILE = "./.spotify-token.json";

let spotifyUserToken = null;
let spotifyUserTokenExpires = 0;
let spotifyUserRefreshToken = null;

// Le catalogue vit en mémoire (catalog-store.js) : chargé depuis GitHub au
// démarrage, les ajouts y sont renvoyés. Plus de relecture du JSON par requête.
function readKnownTracks() {
  return catalog.getTracks();
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

/**
 * GET /api/search?q=
 *
 * Recherche externe pour la barre de recherche des apps (web + iOS),
 * complément de /api/local-search. Source : API publique Deezer via
 * deezer.js (cache 6 h + limiteur global). Plus aucun appel Spotify ici.
 *
 * Réponse : { source: "deezer", results: [ { artist, title, album, year,
 * image, deezerId, isrc, rank, previewUrl, deezerUrl } ], limited?: true }
 * `limited` signale que le quota partagé est atteint : les clients
 * affichent alors le catalogue local seul, sans erreur.
 */
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ source: "deezer", results: [] });
  try {
    const results = await searchTracks(q, 10);
    res.json({ source: "deezer", results });
  } catch (e) {
    if (e instanceof DeezerLimited) {
      return res.json({
        source: "deezer",
        results: [],
        limited: true,
        message: "Recherche externe momentanément limitée, catalogue local seulement.",
      });
    }
    console.error("Erreur /api/search :", e.message);
    res.status(502).json({ source: "deezer", results: [], error: "Recherche externe indisponible" });
  }
});

app.get("/api/known-tracks", (req, res) => {
  res.json(readKnownTracks());
});

/**
 * GET /api/catalog-status[?push=1]
 * État de la persistance : source du catalogue au démarrage, ajouts en
 * attente de commit, résultat du dernier push GitHub. `push=1` force un
 * commit immédiat des ajouts en attente (sinon au plus une fois par minute).
 */
app.get("/api/catalog-status", async (req, res) => {
  if (req.query.push === "1") return res.json(await catalog.pushToGitHub());
  res.json(catalog.getStatus());
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
 * 422 not enough metadata      — Deezer miss, or no BPM/key resolvable
 *
 * Persistence: catalog-store.js appends in memory, writes the local file
 * and commits the batch to GitHub main (debounced), so adds survive Render
 * redeploys. Check /api/catalog-status.
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

  // Saisie manuelle optionnelle (bannière iOS quand aucune source ne
  // répond) : réservée aux profils éditeurs, comme /api/track-correct.
  const manual = {};
  const hasManual = (req.body?.bpm != null && req.body.bpm !== "") || (req.body?.key != null && String(req.body.key).trim() !== "");
  if (hasManual) {
    const expected = process.env.EDITOR_CODE || "";
    const given = String(req.get("X-Editor-Code") || "");
    if (!expected || given !== expected) {
      return res.status(403).json({ found: false, message: "La saisie manuelle du BPM et de la clé est réservée aux profils éditeurs." });
    }
    const manualBpm = Number(req.body?.bpm);
    if (manualBpm >= 40 && manualBpm <= 250) manual.bpm = Math.round(manualBpm);
    const manualKey = req.body?.key ? parseKeyInput(req.body.key) : null;
    if (manualKey) manual.key = manualKey;
  }

  let entry;
  try {
    entry = await buildNewTrack(rawArtist, rawTitle, manual);
  } catch (e) {
    return res.status(500).json({
      found: false,
      message: `Erreur d'enrichissement : ${e.message}`,
    });
  }

  if (!entry) {
    return res.status(422).json({
      found: false,
      message: `Impossible d'enrichir ce titre (Deezer ne l'a pas trouvé ou aucune source n'a remonté BPM + clé).`,
    });
  }

  catalog.append(entry); // mémoire + fichier local + commit GitHub différé

  const sugg = scoreAndPickSuggestions(tracks, entry, 30);
  res.status(200).json({
    found: true,
    alreadyExisted: false,
    current: publicEntry(entry),
    suggestions: sugg,
  });
});

/**
 * POST /api/track-correct  body: { artist, title, bpm?, key? }
 * header X-Editor-Code : code éditeur (EDITOR_CODE sur Render)
 *
 * Correction volontaire par un DJ autorisé (formulaire « Corriger » de
 * l'app iOS, avec récapitulatif et confirmation). Les analyseurs se
 * trompent souvent d'un facteur 2 sur les ballades, seule l'oreille
 * tranche. Les champs modifiés passent en source "manual" (jamais
 * écrasés par le pipeline), les valeurs d'origine sont conservées dans
 * bpmMeasured / keyMeasured, et la persistance passe par catalog-store
 * (commit GitHub). Répond comme /api/suggestions, re-scoré.
 *
 * Sans EDITOR_CODE configuré côté serveur : 503, corrections désactivées.
 * Code absent ou faux : 403. Un DJ qui saisit n'importe quoi pollue toute
 * la base, d'où le garde-fou.
 */
app.post("/api/track-correct", (req, res) => {
  const expected = process.env.EDITOR_CODE || "";
  if (!expected) return res.status(503).json({ found: false, message: "Corrections désactivées sur ce serveur (EDITOR_CODE absent)." });
  const given = String(req.get("X-Editor-Code") || req.body?.editorCode || "");
  if (given !== expected) return res.status(403).json({ found: false, message: "Code éditeur invalide." });

  const rawArtist = req.body?.artist || "";
  const rawTitle = req.body?.title || "";
  if (!rawArtist || !rawTitle) return res.status(400).json({ found: false, message: "Paramètres requis : artist, title" });
  const tracks = readKnownTracks();
  const key = canonicalKey(rawArtist, rawTitle);
  const index = tracks.findIndex((t) => canonicalKey(t.artist, t.title) === key);
  if (index < 0) return res.status(404).json({ found: false, message: "Titre absent du catalogue" });
  const t = tracks[index];

  const fields = {};
  if (req.body?.bpm != null && req.body.bpm !== "") {
    const bpm = Math.round(Number(req.body.bpm));
    if (!(bpm >= 40 && bpm <= 250)) return res.status(422).json({ found: false, message: `BPM ${req.body.bpm} hors limites (40–250)` });
    if (bpm !== t.bpm) { fields.bpm = bpm; fields.bpmSource = "manual"; fields.bpmMeasured = t.bpmMeasured ?? t.bpm ?? null; }
  }
  if (req.body?.key != null && String(req.body.key).trim() !== "") {
    const cam = parseKeyInput(req.body.key);
    if (!cam) return res.status(422).json({ found: false, message: `Clé « ${req.body.key} » non reconnue (attendu 8A, 11B, Am, F#…)` });
    if (cam !== t.key) { fields.key = cam; fields.keySource = "manual"; fields.keyMeasured = t.keyMeasured ?? t.key ?? null; }
  }
  if (!Object.keys(fields).length) return res.status(422).json({ found: false, message: "Aucun changement." });
  fields.correctedAt = new Date().toISOString();

  const updated = catalog.patch(index, fields);
  console.log(`[track-correct] "${t.artist} — ${t.title}" ${t.bpm}/${t.key} → ${updated.bpm}/${updated.key}`);
  res.json({
    found: true,
    current: publicEntry(updated),
    suggestions: scoreAndPickSuggestions(readKnownTracks(), updated, 30),
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
catalog.initLocal();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Après l'ouverture du port : la version GitHub (source de vérité, avec
  // les ajouts poussés depuis le dernier déploiement) remplace le fichier local.
  catalog.refreshFromGitHub().catch((e) => console.warn("refreshFromGitHub :", e.message));
});