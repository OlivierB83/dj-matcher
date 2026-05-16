import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = "./knownTracks.json";

let spotifyAppToken = null;
let spotifyAppTokenExpires = 0;
let spotifyUserToken = null;

function readKnownTracks() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeKnownTracks(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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

function soundchartsKeyToMusicKey(key, mode) {
  const keys = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  if (key === -1 || key === null || key === undefined) return null;
  return mode === 0 ? `${keys[key]}m` : keys[key];
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

async function fetchSoundchartsByIsrc(isrc) {
  if (!process.env.SOUNDCHARTS_APP_ID || !process.env.SOUNDCHARTS_API_KEY) {
    return { found: false, message: "Soundcharts non configuré" };
  }

  const response = await fetch(
    `https://customer.api.soundcharts.com/api/v2.25/song/by-isrc/${encodeURIComponent(isrc)}`,
    {
      headers: {
        "x-app-id": process.env.SOUNDCHARTS_APP_ID,
        "x-api-key": process.env.SOUNDCHARTS_API_KEY,
      },
    }
  );

  if (!response.ok) {
    return { found: false, status: response.status };
  }

  const data = await response.json();
  const song = data.object;
  const audio = song?.audio;

  if (!audio) return { found: false };

  return {
    found: true,
    bpm: Math.round(audio.tempo),
    key: soundchartsKeyToMusicKey(audio.key, audio.mode),
    energy: audio.energy,
    danceability: audio.danceability,
    valence: audio.valence,
    acousticness: audio.acousticness,
    loudness: audio.loudness,
    genres: song?.genres?.map((g) => g.root || g.sub?.[0]).filter(Boolean) || [],
    source: "soundcharts",
  };
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
  const artistRaw = req.query.artist || "";
  const titleRaw = req.query.title || "";
  const albumRaw = req.query.album || "";
  const yearRaw = req.query.year || "";
  const imageRaw = req.query.image || "";
  const isrc = req.query.isrc || "";

  const artist = normalize(artistRaw);
  const title = normalize(titleRaw);

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

  if (!isrc) {
    return res.json({
      found: false,
      source: "none",
      message: "Pas d'ISRC et titre absent du catalogue local",
    });
  }

  const sc = await fetchSoundchartsByIsrc(isrc);

  if (!sc.found) {
    return res.json({
      found: false,
      source: "soundcharts",
      message: "Titre absent du catalogue local et hors sandbox Soundcharts",
      status: sc.status || null,
    });
  }

  const newTrack = {
    title: titleRaw,
    artist: artistRaw,
    album: albumRaw,
    year: yearRaw,
    image: imageRaw,
    bpm: sc.bpm,
    key: sc.key,
    energy: sc.energy,
    danceability: sc.danceability,
    valence: sc.valence,
    acousticness: sc.acousticness,
    loudness: sc.loudness,
    genres: sc.genres,
    isrc,
    source: "soundcharts",
  };

  tracks.push(newTrack);
  writeKnownTracks(tracks);

  res.json({
    found: true,
    ...newTrack,
  });
});

app.get("/api/import-playlist/:playlistId", async (req, res) => {
  if (!spotifyUserToken) {
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
        headers: { Authorization: `Bearer ${spotifyUserToken}` },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    spotifyTotal = data.total;
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});