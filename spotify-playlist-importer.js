import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const OUTPUT_FILE = "./catalog-input.json";

function extractPlaylistId(input) {
  if (!input) return null;

  if (input.includes("open.spotify.com/playlist/")) {
    return input
      .split("open.spotify.com/playlist/")[1]
      .split("?")[0]
      .split("/")[0];
  }

  return input.trim();
}

async function getSpotifyToken() {
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

  if (!data.access_token) {
    throw new Error("Impossible de récupérer le token Spotify");
  }

  return data.access_token;
}

async function fetchPlaylistItems(playlistId, token) {
  let offset = 0;
  const limit = 100;
  const allItems = [];

  while (true) {
    const url =
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
      `?limit=${limit}&offset=${offset}` +
      `&fields=items(track(id,name,artists(name),album(name,release_date,images),external_ids,is_local)),next,total`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Spotify error ${response.status}: ${text}`);
    }

    const data = await response.json();

    allItems.push(...(data.items || []));

    if (!data.next) break;

    offset += limit;
  }

  return allItems;
}

function toCatalogInput(items) {
  const seen = new Set();

  return items
    .map((item) => item.track)
    .filter((track) => track && !track.is_local)
    .map((track) => {
      const artist = track.artists?.[0]?.name || "";
      const title = track.name || "";
      const key = `${artist.toLowerCase()}|||${title.toLowerCase()}`;

      if (!artist || !title || seen.has(key)) return null;

      seen.add(key);

      return {
        title,
        artist,
        album: track.album?.name || null,
        year: track.album?.release_date?.slice(0, 4) || null,
        spotifyId: track.id || null,
        isrc: track.external_ids?.isrc || null,
        image: track.album?.images?.[2]?.url || track.album?.images?.[0]?.url || null,
      };
    })
    .filter(Boolean);
}

async function main() {
  const playlistUrlOrId = process.argv[2];

  if (!playlistUrlOrId) {
    console.log("Usage:");
    console.log("node spotify-playlist-importer.js <playlist_url_or_id>");
    process.exit(1);
  }

  const playlistId = extractPlaylistId(playlistUrlOrId);

  console.log(`Playlist ID : ${playlistId}`);

  const token = await getSpotifyToken();

  console.log("Récupération des titres Spotify...");

  const items = await fetchPlaylistItems(playlistId, token);
  const tracks = toCatalogInput(items);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(tracks, null, 2));

  console.log(`Titres récupérés : ${items.length}`);
  console.log(`Titres exportés : ${tracks.length}`);
  console.log(`Fichier créé : ${OUTPUT_FILE}`);
}

main();