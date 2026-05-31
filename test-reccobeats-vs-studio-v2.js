/**
 * v2 — bypass the catalog: for each studio-verified track, ask Spotify
 * search for the spotifyId, then query ReccoBeats with that id. Comparison
 * is on the *truth from ReccoBeats* vs the user's studio verification, not
 * on whatever we currently store in the catalog.
 */

import "dotenv/config";

const CID = process.env.SPOTIFY_CLIENT_ID;
const CSECRET = process.env.SPOTIFY_CLIENT_SECRET;

const TRACKS = [
  { id: 1,  q: "Michael Jackson Billie Jean",                       studio: { bpm: 118, key: "F#m" } },
  { id: 2,  q: "Men at Work Down Under",                             studio: { bpm: 109, key: "D"   } },
  { id: 3,  q: "Don Omar Danza Kuduro",                              studio: { bpm: 130, key: "C"   } },
  { id: 4,  q: "Elton John I'm Still Standing",                      studio: { bpm: 174, key: "Bb"  } },
  { id: 5,  q: "Rihanna Don't Stop the Music",                       studio: { bpm: 124, key: "F#m" } },
  { id: 6,  q: "Cassius I Love U So",                                studio: { bpm: 126, key: "F"   } },
  { id: 7,  q: "Purple Disco Machine Hypnotized",                    studio: { bpm: 109, key: "D"   } },
  { id: 8,  q: "Calvin Harris Dua Lipa One Kiss",                    studio: { bpm: 124, key: "C"   } },
  { id: 9,  q: "Wham Wake Me Up Before You Go-Go",                   studio: { bpm: 82,  key: "C"   } },
  { id: 10, q: "Pearl Jam Wreckage",                                  studio: { bpm: 105, key: "G"   } },
  { id: 11, q: "Lost Frequencies Kungs Never Going Home",            studio: { bpm: 124, key: "C"   } },
  { id: 12, q: "Robin Schulz Lilly Wood Prayer In C",                 studio: { bpm: 123, key: "C"   } },
];

const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function keyFromSpotify(k, mode) {
  if (k == null) return "?";
  const letter = KEY_NAMES[k];
  return mode === 0 ? letter + "m" : letter;
}

async function getToken() {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${CID}:${CSECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  return (await r.json()).access_token;
}

async function spotifySearch(token, q) {
  const r = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.tracks?.items?.[0] || null;
}

async function reccoFeatures(spotifyId) {
  const lookup = await fetch(`https://api.reccobeats.com/v1/track?ids=${spotifyId}`);
  if (!lookup.ok) return null;
  const data = await lookup.json();
  const rb = data.content?.[0];
  if (!rb) return { notFound: true };
  const f = await fetch(`https://api.reccobeats.com/v1/track/${rb.id}/audio-features`);
  if (!f.ok) return null;
  return await f.json();
}

function classifyKey(reccoKey, studioKey) {
  if (!reccoKey || !studioKey) return "?";
  const r = reccoKey.replace(/♯/g, "#");
  if (r === studioKey) return "✅";
  const rL = r.replace(/m$/, ""), sL = studioKey.replace(/m$/, "");
  const rMin = r.endsWith("m"), sMin = studioKey.endsWith("m");
  if (rL === sL && rMin !== sMin) return "≈ parallel";
  // Enharmonic equivalence (A# = Bb, C# = Db, D# = Eb, F# = Gb, G# = Ab)
  const enharmonic = { "A#": "Bb", "Bb": "A#", "C#": "Db", "Db": "C#", "D#": "Eb", "Eb": "D#", "F#": "Gb", "Gb": "F#", "G#": "Ab", "Ab": "G#" };
  const rEn = (enharmonic[rL] || rL) + (rMin ? "m" : "");
  if (rEn === studioKey) return "✅ (enharm)";
  return "❌";
}

async function main() {
  const token = await getToken();
  console.log("| # | Spotify track            | Recco BPM/Key | Studio    | Verdict |");
  console.log("|---|--------------------------|---------------|-----------|---------|");
  let exact = 0, parallel = 0, wrong = 0, na = 0;
  let bpmOk = 0, bpmBad = 0;

  for (const t of TRACKS) {
    const sp = await spotifySearch(token, t.q);
    if (!sp) {
      console.log(`| ${t.id} | (Spotify miss) | — | — | ❌ |`);
      na++;
      continue;
    }
    const feat = await reccoFeatures(sp.id);
    if (!feat || feat.notFound) {
      console.log(
        `| ${t.id} | ${sp.name.slice(0, 20).padEnd(25)} | not in Recco | ${t.studio.bpm}/${t.studio.key.padEnd(4)} | ❌ |`
      );
      na++;
      continue;
    }
    const recoBpm = Math.round(feat.tempo);
    const recoKey = keyFromSpotify(feat.key, feat.mode);
    const bpmDiff = Math.abs(recoBpm - t.studio.bpm);
    const halfOk = Math.abs(recoBpm * 2 - t.studio.bpm) <= 2 || Math.abs(recoBpm / 2 - t.studio.bpm) <= 2;
    if (bpmDiff <= 3 || halfOk) bpmOk++;
    else bpmBad++;
    const verdict = classifyKey(recoKey, t.studio.key);
    if (verdict.startsWith("✅")) exact++;
    else if (verdict.startsWith("≈")) parallel++;
    else wrong++;
    console.log(
      `| ${t.id.toString().padStart(2)} | ${sp.name.slice(0, 25).padEnd(25)} | ${(recoBpm + " / " + recoKey).padEnd(13)} | ${(t.studio.bpm + "/" + t.studio.key).padEnd(9)} | ${verdict} |`
    );
  }

  console.log("");
  console.log(`Keys  → ✅ exact: ${exact} · ≈ parallel: ${parallel} · ❌ wrong: ${wrong} · n/a: ${na}`);
  console.log(`BPM   → ✅ ok (±3 or halved/doubled): ${bpmOk} · ❌ bad: ${bpmBad}`);
}

main().catch(console.error);
