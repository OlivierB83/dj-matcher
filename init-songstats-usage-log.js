import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const LOG_FILE = "./songstats-usage-log.json";

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;
  const content = fs.readFileSync(file, "utf8").trim();
  if (!content) return fallback;
  return JSON.parse(content);
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const knownTracks = readJson(KNOWN_FILE, []);
const existingLogs = readJson(LOG_FILE, []);

const alreadyLogged = new Set(
  existingLogs.map((x) => x.spotifyId || x.isrc || `${x.artist}-${x.title}`)
);

const now = new Date();

const initialLogs = knownTracks
  .filter((track) => track.source === "songstats")
  .filter((track) => {
    const key = track.spotifyId || track.isrc || `${track.artist}-${track.title}`;
    return !alreadyLogged.has(key);
  })
  .map((track) => ({
    date: now.toISOString(),
    month: now.toISOString().slice(0, 7),
    title: track.title,
    artist: track.artist,
    spotifyId: track.spotifyId || null,
    isrc: track.isrc || null,
    source: "songstats",
    origin: "initial_backfill_from_knownTracks"
  }));

const mergedLogs = [...existingLogs, ...initialLogs];

writeJson(LOG_FILE, mergedLogs);

console.log(`Titres Songstats dans knownTracks : ${knownTracks.filter(t => t.source === "songstats").length}`);
console.log(`Déjà présents dans le log : ${existingLogs.length}`);
console.log(`Ajoutés au log initial : ${initialLogs.length}`);
console.log(`Total log : ${mergedLogs.length}`);