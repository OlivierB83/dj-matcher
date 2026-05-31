import "dotenv/config";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env");
  process.exit(1);
}

async function getAppToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function audioFeatures(token, id) {
  const res = await fetch(`https://api.spotify.com/v1/audio-features/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

async function audioFeaturesBatch(token, ids) {
  const res = await fetch(
    `https://api.spotify.com/v1/audio-features?ids=${ids.join(",")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

async function main() {
  console.log("→ Demande d'un token client_credentials…");
  const token = await getAppToken();
  console.log("✓ Token reçu (préfixe:", token.slice(0, 10) + "…)");
  console.log("");

  // Test 1: a well-known Spotify track ID
  // "Daft Punk — One More Time" : 0DiWol3AO6WpXZgp0goxAV
  const testId = "0DiWol3AO6WpXZgp0goxAV";
  console.log(`→ Test simple : /v1/audio-features/${testId} (Daft Punk — One More Time)`);
  const single = await audioFeatures(token, testId);
  console.log(`  HTTP ${single.status}`);
  if (single.status === 200) {
    const f = single.body;
    console.log(`  ✅ BPM=${f.tempo} · key=${f.key} · mode=${f.mode} · dance=${f.danceability} · energy=${f.energy}`);
  } else {
    console.log(`  ❌ Réponse: ${single.body.slice(0, 300)}`);
  }
  console.log("");

  // Test 2: batch (up to 100 ids)
  const ids = [testId, "6XRthTV7Mu1LmZB58Kx305", "3SvRPkqbtustFGRYXtJ1hK"];
  console.log(`→ Test batch : /v1/audio-features?ids=…  (${ids.length} IDs)`);
  const batch = await audioFeaturesBatch(token, ids);
  console.log(`  HTTP ${batch.status}`);
  if (batch.status === 200) {
    const features = batch.body.audio_features || [];
    features.forEach((f, i) => {
      if (!f) {
        console.log(`  [${i}] null (id introuvable)`);
      } else {
        console.log(`  [${i}] BPM=${f.tempo} · key=${f.key} · mode=${f.mode} · ${ids[i]}`);
      }
    });
  } else {
    console.log(`  ❌ Réponse: ${batch.body.slice(0, 500)}`);
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
