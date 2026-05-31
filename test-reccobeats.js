/**
 * Deeper probe of ReccoBeats: try every plausible endpoint on the internal
 * UUID returned by /v1/track?ids=...
 */

const TRACKS = [
  { name: "Daft Punk — One More Time",     spotifyId: "0DiWol3AO6WpXZgp0goxAV" },
  { name: "Coldplay — Adventure",          spotifyId: "6XRthTV7Mu1LmZB58Kx305" },
  { name: "Rihanna — Don't Stop",          spotifyId: "1Cv1YLb4q0RzL6pybtaMLo" },
  { name: "MJ — Billie Jean",              spotifyId: "5ChkMS8OtdzJeqyybCc9R5" },
];

async function lookup(spotifyId) {
  const res = await fetch(`https://api.reccobeats.com/v1/track?ids=${spotifyId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.content?.[0] || null;
}

async function tryEndpoints(rbId) {
  const endpoints = [
    `https://api.reccobeats.com/v1/track/${rbId}/audio-features`,
    `https://api.reccobeats.com/v1/audio-features/${rbId}`,
    `https://api.reccobeats.com/v1/audio-features?ids=${rbId}`,
    `https://api.reccobeats.com/v1/track/${rbId}`,
    `https://api.reccobeats.com/v1/track/${rbId}/audio-analysis`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      const short = text.length > 250 ? text.slice(0, 250) + "…" : text;
      console.log(`    ${url}`);
      console.log(`      HTTP ${res.status} · ${short}`);
    } catch (e) {
      console.log(`    ${url}\n      ❌ ${e.message}`);
    }
  }
}

async function main() {
  for (const track of TRACKS) {
    console.log(`\n=== ${track.name} (spotifyId=${track.spotifyId}) ===`);
    const found = await lookup(track.spotifyId);
    if (!found) {
      console.log("  /v1/track?ids → empty");
      continue;
    }
    console.log(`  ReccoBeats UUID: ${found.id}`);
    console.log(`  ReccoBeats fields exposés:`, Object.keys(found).join(", "));
    console.log("  → endpoints sur cet UUID :");
    await tryEndpoints(found.id);
  }
}

main();
