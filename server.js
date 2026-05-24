import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

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
  const artist = normalize(req.query.artist || "");
  const title = normalize(req.query.title || "");

  const tracks = readKnownTracks();

  const localMatch = tracks.find(
    (track) =>
      normalize(track.artist) === artist &&
      normalize(track.title) === title
  );

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