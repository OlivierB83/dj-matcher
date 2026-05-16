import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const MANUAL_FILE = "./manual-import.json";

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function exists(tracks, candidate) {
  return tracks.some(
    (track) =>
      normalize(track.artist) === normalize(candidate.artist) &&
      normalize(track.title) === normalize(candidate.title)
  );
}

async function main() {
  const knownTracks = readJson(KNOWN_FILE, []);
  const manualTracks = readJson(MANUAL_FILE, []);

  console.log(`Catalogue actuel : ${knownTracks.length}`);
  console.log(`Imports manuels : ${manualTracks.length}`);
  console.log("");

  let added = 0;
  let skipped = 0;

  for (const track of manualTracks) {
    const label = `${track.title} — ${track.artist}`;

    if (exists(knownTracks, track)) {
      console.log(`⏭️  Déjà présent : ${label}`);
      skipped++;
      continue;
    }

    knownTracks.push(track);

    console.log(
      `✅ Ajouté : ${label} (${track.bpm} BPM, ${track.key})`
    );

    added++;
  }

  writeJson(KNOWN_FILE, knownTracks);

  console.log("");
  console.log("Terminé.");
  console.log(`Ajoutés : ${added}`);
  console.log(`Ignorés : ${skipped}`);
  console.log(`Total catalogue : ${knownTracks.length}`);
}

main();