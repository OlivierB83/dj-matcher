/**
 * Probe several BPM/key sources to find a replacement for Spotify Audio
 * Features (which now 403s on our app credentials).
 *
 * Targets tested:
 *   1. ReccoBeats     — designed as a Spotify Audio Features drop-in
 *   2. AcousticBrainz — frozen but still queryable, needs MBID
 *   3. TheAudioDB     — crowd-sourced, free
 */

const TEST_TRACKS = [
  { name: "Daft Punk — One More Time", spotifyId: "0DiWol3AO6WpXZgp0goxAV", artist: "Daft Punk", title: "One More Time" },
  { name: "Coldplay — Adventure of a Lifetime", spotifyId: "6XRthTV7Mu1LmZB58Kx305", artist: "Coldplay", title: "Adventure of a Lifetime" },
  { name: "Rihanna — Don't Stop the Music", spotifyId: "1Cv1YLb4q0RzL6pybtaMLo", artist: "Rihanna", title: "Don't Stop the Music" },
];

async function probeReccoBeats(track) {
  // From reccobeats.com docs (public, free tier exists)
  const endpoints = [
    `https://api.reccobeats.com/v1/track/${track.spotifyId}/audio-features`,
    `https://api.reccobeats.com/v1/audio-features/${track.spotifyId}`,
    `https://api.reccobeats.com/v1/track?ids=${track.spotifyId}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      console.log(`    ${url}`);
      console.log(`      HTTP ${res.status} · ${text.slice(0, 200)}`);
    } catch (e) {
      console.log(`      ❌ ${url} :: ${e.message}`);
    }
  }
}

async function probeAcousticBrainz(track) {
  // AcousticBrainz keys data by MusicBrainz Recording MBID. We don't have
  // one, so we first ask MusicBrainz to resolve title+artist → MBID.
  try {
    const mbUrl =
      `https://musicbrainz.org/ws/2/recording?query=` +
      encodeURIComponent(`recording:"${track.title}" AND artist:"${track.artist}"`) +
      `&fmt=json&limit=1`;
    const mbRes = await fetch(mbUrl, {
      headers: { "User-Agent": "dj-matcher/0.1 (test)" },
    });
    if (!mbRes.ok) {
      console.log(`    MusicBrainz HTTP ${mbRes.status}`);
      return;
    }
    const mbData = await mbRes.json();
    const recording = mbData.recordings?.[0];
    if (!recording) {
      console.log("    MusicBrainz: pas de résultat");
      return;
    }
    const mbid = recording.id;
    console.log(`    MBID résolu → ${mbid}`);

    // Try the high-level endpoint (key, BPM, mood)
    const abUrl = `https://acousticbrainz.org/api/v1/${mbid}/high-level`;
    const abRes = await fetch(abUrl);
    console.log(`    AcousticBrainz high-level HTTP ${abRes.status}`);
    if (abRes.ok) {
      const ab = await abRes.json();
      console.log(`    ✅ keys: ${Object.keys(ab.highlevel || {}).slice(0, 8).join(", ")}`);
    } else {
      console.log(`    (réponse: ${(await abRes.text()).slice(0, 200)})`);
    }

    // Also the low-level (true BPM + key in tonal analysis)
    const llUrl = `https://acousticbrainz.org/api/v1/${mbid}/low-level`;
    const llRes = await fetch(llUrl);
    console.log(`    AcousticBrainz low-level HTTP ${llRes.status}`);
    if (llRes.ok) {
      const ll = await llRes.json();
      const bpm = ll.rhythm?.bpm;
      const key = ll.tonal?.key_key;
      const scale = ll.tonal?.key_scale;
      console.log(`    ✅ BPM=${bpm?.toFixed?.(1)} · key=${key} ${scale}`);
    }
  } catch (e) {
    console.log(`    ❌ ${e.message}`);
  }
}

async function probeAudioDB(track) {
  try {
    const url =
      `https://www.theaudiodb.com/api/v1/json/2/searchtrack.php?s=` +
      encodeURIComponent(track.artist) +
      `&t=` +
      encodeURIComponent(track.title);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`    HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const t = data.track?.[0];
    if (!t) {
      console.log("    pas de résultat");
      return;
    }
    console.log(
      `    ✅ Track found · BPM (intMusicBrainzID): ${t.intMusicBrainzID || "?"}`
    );
    // TheAudioDB rarely has BPM/key directly. They sometimes link to
    // MusicBrainz where AcousticBrainz can pick up.
    const keys = Object.keys(t).filter((k) => /bpm|tempo|key|mood/i.test(k));
    console.log(`    Champs musical-data : ${keys.join(", ") || "—"}`);
  } catch (e) {
    console.log(`    ❌ ${e.message}`);
  }
}

async function main() {
  for (const track of TEST_TRACKS) {
    console.log(`\n=== ${track.name} (spotifyId=${track.spotifyId}) ===`);

    console.log("\n  → ReccoBeats");
    await probeReccoBeats(track);

    console.log("\n  → AcousticBrainz (via MusicBrainz)");
    await probeAcousticBrainz(track);
    // MusicBrainz asks for ≥1s between requests
    await new Promise((r) => setTimeout(r, 1100));

    console.log("\n  → TheAudioDB");
    await probeAudioDB(track);
  }
}

main();
