/**
 * Run the 12 user-studio-verified tracks through ReccoBeats and compare.
 * Goal: confirm whether ReccoBeats keys are noticeably better than Songstats
 * (which scored 25 % key accuracy) before we migrate the catalog.
 */

import fs from "fs";

const TRACKS = [
  { id: 1,  artist: "Michael Jackson",    title: "Billie Jean",          studio: { bpm: 118, key: "F#m" } },
  { id: 2,  artist: "Men at Work",        title: "Down Under",            studio: { bpm: 109, key: "D"   } },
  { id: 3,  artist: "Don Omar",           title: "Danza Kuduro",          studio: { bpm: 130, key: "C"   } },
  { id: 4,  artist: "Elton John",         title: "I'm Still Standing",    studio: { bpm: 174, key: "Bb"  } },
  { id: 5,  artist: "Rihanna",            title: "Don't Stop the Music",  studio: { bpm: 124, key: "F#m" } },
  { id: 6,  artist: "Cassius",            title: "I <3 U SO",             studio: { bpm: 126, key: "F"   } },
  { id: 7,  artist: "Purple Disco Machine", title: "Hypnotized",          studio: { bpm: 109, key: "D"   } },
  { id: 8,  artist: "Calvin Harris",      title: "One Kiss",              studio: { bpm: 124, key: "C"   } },
  { id: 9,  artist: "Wham!",              title: "Wake Me Up Before You Go-Go", studio: { bpm: 82, key: "C" } },
  { id: 10, artist: "Pearl Jam",          title: "Wreckage",              studio: { bpm: 105, key: "G"   } },
  { id: 11, artist: "Lost Frequencies",   title: "Never Going Home",      studio: { bpm: 124, key: "C"   } },
  { id: 12, artist: "Lilly Wood",         title: "Prayer In C",           studio: { bpm: 123, key: "C"   } },
];

// Spotify integer key (0-11) + mode (0/1) → human-readable letter notation
const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function keyFromSpotify(k, mode) {
  if (k == null) return "?";
  const letter = KEY_NAMES[k];
  return mode === 0 ? letter + "m" : letter;
}

const KNOWN = JSON.parse(fs.readFileSync("./knownTracks.json", "utf8"));

function findInCatalog(target) {
  // simple lowercase substring match, prefer entries that have a spotifyId
  const a = target.artist.toLowerCase();
  const t = target.title.toLowerCase().split(/[\s-]/)[0]; // first word for robustness
  const matches = KNOWN.filter(
    (k) =>
      (k.artist || "").toLowerCase().includes(a) &&
      (k.title || "").toLowerCase().includes(t)
  );
  // Prefer entries with a Spotify ID so we can actually query ReccoBeats
  return matches.find((m) => m.spotifyId) || matches[0];
}

async function reccoFeatures(spotifyId) {
  if (!spotifyId) return null;
  const lookup = await fetch(`https://api.reccobeats.com/v1/track?ids=${spotifyId}`);
  if (!lookup.ok) return null;
  const data = await lookup.json();
  const track = data.content?.[0];
  if (!track) return { notFound: true };
  const f = await fetch(`https://api.reccobeats.com/v1/track/${track.id}/audio-features`);
  if (!f.ok) return null;
  return await f.json();
}

// Compare two keys allowing exact match and rel-major / parallel rules
function classifyKey(reccoKey, studioKey) {
  if (!reccoKey || !studioKey) return "?";
  const r = reccoKey.replace(/♯/g, "#");
  if (r === studioKey) return "✅ EXACT";
  // strip suffix to compare letter notes
  const rLetter = r.replace(/m$/, "");
  const sLetter = studioKey.replace(/m$/, "");
  const rMinor = r.endsWith("m");
  const sMinor = studioKey.endsWith("m");
  if (rLetter === sLetter && rMinor !== sMinor) return "≈ parallel (same root, diff mode)";
  return "❌ DIFFERENT";
}

async function main() {
  console.log("|  # | Catalog source | Catalog key | Recco key/mode | Studio key | Verdict |");
  console.log("|----|---------------|-------------|----------------|-----------|---------|");
  let exactKey = 0, parallelKey = 0, wrongKey = 0, notFound = 0;
  let bpmGood = 0, bpmClose = 0, bpmBad = 0;

  for (const t of TRACKS) {
    const cat = findInCatalog(t);
    if (!cat) {
      console.log(`| ${t.id} | — pas trouvé en catalogue — |`);
      notFound++;
      continue;
    }
    const feat = await reccoFeatures(cat.spotifyId);
    let recoStr = "—";
    let bpmStr = "—";
    let verdict = "?";
    if (!feat) {
      recoStr = "API error";
      verdict = "❌ no data";
      notFound++;
    } else if (feat.notFound) {
      recoStr = "not in ReccoBeats";
      verdict = "❌ no data";
      notFound++;
    } else {
      const recoKey = keyFromSpotify(feat.key, feat.mode);
      const recoBpm = Math.round(feat.tempo);
      recoStr = `${recoBpm} / ${recoKey} (k=${feat.key},m=${feat.mode})`;
      bpmStr = `${recoBpm} vs ${t.studio.bpm}`;
      const bpmDiff = Math.abs(recoBpm - t.studio.bpm);
      const halfDiff = Math.abs(recoBpm * 2 - t.studio.bpm);
      const doubleDiff = Math.abs(recoBpm / 2 - t.studio.bpm);
      if (bpmDiff <= 2 || halfDiff <= 2 || doubleDiff <= 2) bpmGood++;
      else if (bpmDiff <= 5) bpmClose++;
      else bpmBad++;
      verdict = classifyKey(recoKey, t.studio.key);
      if (verdict.startsWith("✅")) exactKey++;
      else if (verdict.startsWith("≈")) parallelKey++;
      else wrongKey++;
    }
    console.log(
      `| ${t.id.toString().padStart(2)} | ${(cat.source || "?").padEnd(11)} | ${
        (cat.bpm + " / " + cat.key).padEnd(11)
      } | ${recoStr.padEnd(26)} | ${(t.studio.bpm + " / " + t.studio.key).padEnd(9)} | ${verdict} |`
    );
  }

  console.log("");
  console.log(`Key  → exact: ${exactKey} · parallel: ${parallelKey} · wrong: ${wrongKey} · n/a: ${notFound}`);
  console.log(`BPM  → ok (±2 or harmonic): ${bpmGood} · close (±5): ${bpmClose} · bad: ${bpmBad}`);
}

main().catch(console.error);
