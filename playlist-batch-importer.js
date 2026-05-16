import fs from "fs";

const PLAYLISTS_FILE = "./playlists.json";
const OUTPUT_FILE = "./catalog-input.json";

const API_BASE = "http://127.0.0.1:3001";

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function readJsonFile(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function importPlaylist(playlistId) {
  const url = `${API_BASE}/api/import-playlist/${playlistId}`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Erreur playlist ${playlistId}: ${response.status} ${text}`
    );
  }

  return response.json();
}

async function main() {
  const playlists = readJsonFile(PLAYLISTS_FILE, []);

  if (playlists.length === 0) {
    console.log("Aucune playlist dans playlists.json");
    return;
  }

  console.log(`Playlists à importer : ${playlists.length}`);
  console.log("");

  let mergedTracks = [];

  for (const [index, playlist] of playlists.entries()) {
    const playlistId = extractPlaylistId(playlist);

    console.log(
      `🎵 ${index + 1}/${playlists.length} Import playlist ${playlistId}`
    );

    try {
      const result = await importPlaylist(playlistId);

      console.log(
        `   ✅ ${result.imported} titres récupérés`
      );

      const importedTracks = readJsonFile(
        "./catalog-input.json",
        []
      );

      mergedTracks.push(...importedTracks);
    } catch (error) {
      console.log(`   ❌ ${error.message}`);
    }
  }

  console.log("");
  console.log(`Titres avant dédoublonnage : ${mergedTracks.length}`);

  const seen = new Set();

  mergedTracks = mergedTracks.filter((track) => {
    const key =
      normalize(track.artist) +
      "|||" +
      normalize(track.title);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  console.log(`Titres uniques : ${mergedTracks.length}`);

  writeJsonFile(OUTPUT_FILE, mergedTracks);

  console.log("");
  console.log(`✅ Fichier généré : ${OUTPUT_FILE}`);
}

main();