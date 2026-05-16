import fs from "fs";
import "dotenv/config";

const INPUT_FILE = "./catalog-input.json";
const KNOWN_FILE = "./knownTracks.json";
const FAILURES_FILE = "./catalog-failures.json";

const GETSONGBPM_API_KEY = process.env.GETSONGBPM_API_KEY;
const SONGSTATS_API_KEY = process.env.SONGSTATS_API_KEY;

const MAX_TRACKS_PER_RUN = 500;
const DELAY_MS = 120;


let songstatsRequests = 0;
let songstatsAdded = 0;
let getSongBpmAdded = 0;


const SONGSTATS_USAGE_LOG_FILE = "./songstats-usage-log.json";

function logSongstatsRequest(track) {
  const logs = readJson(SONGSTATS_USAGE_LOG_FILE, []);
  const now = new Date();

  logs.push({
    date: now.toISOString(),
    month: now.toISOString().slice(0, 7),
    title: track.title,
    artist: track.artist,
    spotifyId: track.spotifyId || null,
    isrc: track.isrc || null,
  });

  writeJson(SONGSTATS_USAGE_LOG_FILE, logs);
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
    .replace(/- radio edit.*/gi, "")
    .replace(/- edit.*/gi, "")
    .replace(/version.*/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;

  const content = fs.readFileSync(file, "utf8").trim();

  if (!content) return fallback;

  return JSON.parse(content);
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function alreadyKnown(knownTracks, candidate) {
  return knownTracks.find(
    (track) =>
      normalize(track.title) === normalize(candidate.title) &&
      normalize(track.artist) === normalize(candidate.artist)
  );
}

function normalizeBpm(bpm) {
  let value = Number(bpm);

  if (!value) return null;

  if (value > 180) value = value / 2;
  if (value < 70) value = value * 2;

  return Math.round(value);
}

function normalizeKey(key) {
  if (!key) return null;

  return String(key)
    .replace("♯", "#")
    .replace("♭", "b")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchGetSongBPM(track) {
  if (!GETSONGBPM_API_KEY) return null;

  try {
    const lookup = `song:${track.title} artist:${track.artist}`;

    const url =
      `https://api.getsong.co/search/` +
      `?api_key=${GETSONGBPM_API_KEY}` +
      `&type=both` +
      `&lookup=${encodeURIComponent(lookup)}` +
      `&limit=5`;

    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();
    const results = data.search || [];

    if (!results.length) return null;

    const targetTitle = normalize(track.title);
    const targetArtist = normalize(track.artist);

    const best =
      results.find(
        (song) =>
          normalize(song.title) === targetTitle &&
          normalize(song.artist?.name) === targetArtist
      ) ||
      results.find((song) => normalize(song.title) === targetTitle) ||
      results[0];

    const bpm = normalizeBpm(best.tempo);
    const key = normalizeKey(best.key_of);

    if (!bpm || !key) return null;

    return {
      title: best.title || track.title,
      artist: best.artist?.name || track.artist,
      album: best.album?.title || track.album || null,
      year: best.album?.year || track.year || null,
      bpm,
      key,
      danceability:
        best.danceability !== undefined ? Number(best.danceability) / 100 : null,
      acousticness:
        best.acousticness !== undefined ? Number(best.acousticness) / 100 : null,
      genres: best.artist?.genres || [],
      country: best.artist?.from || null,
      mbid: best.artist?.mbid || null,
      uri: best.uri || null,
      spotifyId: track.spotifyId || null,
      isrc: track.isrc || null,
      image: track.image || null,
      source: "getsongbpm",
    };
  } catch (error) {
    console.log("GetSongBPM error:", error.message);
    return null;
  }
}

async function searchSongstats(track) {
  if (!SONGSTATS_API_KEY) return null;
  if (!track.spotifyId && !track.isrc) return null;

  try {
    let url;

    if (track.isrc) {
      url =
        `https://api.songstats.com/enterprise/v1/tracks/info` +
        `?isrc=${encodeURIComponent(track.isrc)}`;
    } else {
      url =
        `https://api.songstats.com/enterprise/v1/tracks/info` +
        `?spotify_track_id=${encodeURIComponent(track.spotifyId)}`;
    }

    songstatsRequests++;
    logSongstatsRequest(track);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        apikey: SONGSTATS_API_KEY,
      },
    });

    if (!response.ok) {
      console.log(`Songstats HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    const info = data.track_info || {};
    const analysisArray = data.audio_analysis || [];

    const audio = Object.fromEntries(
      analysisArray.map((item) => [item.key, item.value])
    );

    const bpm = normalizeBpm(audio.tempo);
    const key = normalizeKey(audio.key);

    if (!bpm || !key) {
      console.log("Songstats trouvé mais sans BPM/key");
      return null;
    }

    const spotifyLink = info.links?.find((link) => link.source === "spotify");

    return {
      title: info.title || track.title,
      artist: Array.isArray(info.artists)
        ? info.artists.map((a) => a.name).join(", ")
        : track.artist,
      album: track.album || null,
      year: info.release_date?.slice(0, 4) || track.year || null,
      bpm,
      key,
      danceability:
        audio.danceability !== undefined ? Number(audio.danceability) : null,
      energy: audio.energy !== undefined ? Number(audio.energy) : null,
      valence: audio.valence !== undefined ? Number(audio.valence) : null,
      acousticness:
        audio.acousticness !== undefined ? Number(audio.acousticness) : null,
      loudness: audio.loudness !== undefined ? Number(audio.loudness) : null,
      genres: info.genres || [],
      spotifyId: track.spotifyId || spotifyLink?.external_id || null,
      isrc: track.isrc || spotifyLink?.isrc || null,
      image: track.image || info.avatar || null,
      source: "songstats",
    };
  } catch (error) {
    console.log("Songstats error:", error.message);
    return null;
  }
}

async function enrichTrack(track) {
  console.log(`🔎 Recherche : ${track.title} — ${track.artist}`);

  const fromGetSongBPM = await searchGetSongBPM(track);

  if (fromGetSongBPM?.bpm && fromGetSongBPM?.key) {
    console.log(
      `✅ GetSongBPM : ${fromGetSongBPM.title} (${fromGetSongBPM.bpm} BPM, ${fromGetSongBPM.key})`
    );
    return fromGetSongBPM;
  }

  console.log("   ↳ fallback Songstats...");

  const fromSongstats = await searchSongstats(track);

  if (fromSongstats?.bpm && fromSongstats?.key) {
    console.log(
      `✅ Songstats : ${fromSongstats.title} (${fromSongstats.bpm} BPM, ${fromSongstats.key})`
    );
    return fromSongstats;
  }

  console.log(`❌ Non trouvé : ${track.title} — ${track.artist}`);
  return null;
}

async function main() {
  const inputTracks = readJson(INPUT_FILE, []);
  const knownTracks = readJson(KNOWN_FILE, []);
  const failures = [];

  console.log(`Catalogue actuel : ${knownTracks.length}`);
  console.log(`Input : ${inputTracks.length} titres`);
  console.log(`Traitement max : ${MAX_TRACKS_PER_RUN} titres`);
  console.log("");

  let added = 0;
  let skipped = 0;
  let failed = 0;

  const tracksToProcess = inputTracks.slice(0, MAX_TRACKS_PER_RUN);

  for (const [index, track] of tracksToProcess.entries()) {
    const position = `${index + 1}/${tracksToProcess.length}`;

    if (alreadyKnown(knownTracks, track)) {
      console.log(
        `⏭️  ${position} Déjà présent : ${track.title} — ${track.artist}`
      );
      skipped++;
      continue;
    }

    console.log(position);

    const enriched = await enrichTrack(track);

    if (enriched) {
      knownTracks.push({
        ...track,
        ...enriched,
      });

      if (enriched.source === "songstats") songstatsAdded++;
      if (enriched.source === "getsongbpm") getSongBpmAdded++;

      writeJson(KNOWN_FILE, knownTracks);

      added++;
    } else {
      failures.push({
        title: track.title,
        artist: track.artist,
        album: track.album || null,
        year: track.year || null,
        spotifyId: track.spotifyId || null,
        isrc: track.isrc || null,
        image: track.image || null,
        reason: "not_found",
      });

      failed++;
    }

    await sleep(DELAY_MS);
  }

  writeJson(FAILURES_FILE, failures);

  console.log("");
  console.log("Terminé.");
  console.log(`Ajoutés : ${added}`);
  console.log(`Déjà présents : ${skipped}`);
  console.log(`Échecs : ${failed}`);
  console.log(`Total catalogue : ${knownTracks.length}`);
  console.log("");
  console.log("Détail enrichissement :");
  console.log(`Ajoutés via GetSongBPM : ${getSongBpmAdded}`);
  console.log(`Ajoutés via Songstats : ${songstatsAdded}`);
  console.log(`Requêtes Songstats effectuées : ${songstatsRequests}`);
  console.log(
    `Coût estimé Songstats : ${(songstatsRequests * 0.01).toFixed(2)} €`
  );
  console.log(`Échecs sauvegardés dans : ${FAILURES_FILE}`);
}

main();