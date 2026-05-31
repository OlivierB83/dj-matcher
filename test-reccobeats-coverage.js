/**
 * Two questions to answer:
 *   1. What's the full audio-features payload look like? (need BPM/tempo field)
 *   2. What's the coverage on our real catalog? Sample 50 random spotifyIds.
 *   3. Does batch /v1/track?ids=a,b,c work?
 */

import fs from "fs";

const KNOWN = JSON.parse(fs.readFileSync("./knownTracks.json", "utf8"));

function sample(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function lookupTrack(spotifyId) {
  const res = await fetch(`https://api.reccobeats.com/v1/track?ids=${spotifyId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.content?.[0] || null;
}

async function audioFeatures(rbId) {
  const res = await fetch(
    `https://api.reccobeats.com/v1/track/${rbId}/audio-features`
  );
  if (!res.ok) return null;
  return await res.json();
}

async function batchLookup(ids) {
  const res = await fetch(`https://api.reccobeats.com/v1/track?ids=${ids.join(",")}`);
  if (!res.ok) return null;
  return await res.json();
}

async function main() {
  /* 1. Full payload */
  console.log("=== 1. Full audio-features payload (Daft Punk - One More Time) ===");
  const dpFound = await lookupTrack("0DiWol3AO6WpXZgp0goxAV");
  const dpFeat = await audioFeatures(dpFound.id);
  console.log(JSON.stringify(dpFeat, null, 2));
  console.log("");

  /* 2. Batch query */
  console.log("=== 2. Batch /v1/track?ids=...  (5 IDs in one call) ===");
  const batchIds = [
    "0DiWol3AO6WpXZgp0goxAV",
    "5ChkMS8OtdzJeqyybCc9R5",
    "6XRthTV7Mu1LmZB58Kx305",
    "3SvRPkqbtustFGRYXtJ1hK",
    "1Cv1YLb4q0RzL6pybtaMLo",
  ];
  const batch = await batchLookup(batchIds);
  console.log(`HTTP 200 · content.length = ${batch?.content?.length || 0}`);
  console.log("Found IDs:", (batch?.content || []).map((t) => t.id).join(", "));
  console.log("");

  /* 3. Coverage on a 50-track sample from our catalog */
  console.log("=== 3. Coverage sur 50 spotifyIds aléatoires du catalogue ===");
  const eligible = KNOWN.filter((t) => t.spotifyId);
  const sampled = sample(eligible, 50);
  console.log(`Échantillon: ${sampled.length} tracks (sur ${eligible.length} avec spotifyId)`);

  // Batch them in chunks of 25 (URL length safety)
  let found = 0;
  let notFound = 0;
  const examples = { found: [], notFound: [] };
  for (let i = 0; i < sampled.length; i += 25) {
    const chunk = sampled.slice(i, i + 25);
    const ids = chunk.map((t) => t.spotifyId);
    const data = await batchLookup(ids);
    if (!data) continue;
    const foundIds = new Set((data.content || []).map((c) => c.href?.split("/track/")[1]));
    chunk.forEach((t) => {
      if (foundIds.has(t.spotifyId)) {
        found++;
        if (examples.found.length < 3) examples.found.push(`${t.artist} — ${t.title}`);
      } else {
        notFound++;
        if (examples.notFound.length < 3) examples.notFound.push(`${t.artist} — ${t.title}`);
      }
    });
  }
  console.log(`Trouvés     : ${found} (${((found / sampled.length) * 100).toFixed(0)}%)`);
  console.log(`Non trouvés : ${notFound}`);
  console.log("");
  console.log("Exemples trouvés :", examples.found.join(" / "));
  console.log("Exemples non trouvés :", examples.notFound.join(" / "));
}

main().catch(console.error);
