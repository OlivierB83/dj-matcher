/**
 * Catalog enrichment via ReccoBeats (= Spotify Audio Features schema)
 * with a per-source, non-harmonic-aware policy.
 *
 * BPM policy (the tricky one — harmonic ambiguity is real):
 *   - source = djay_pro  → never touched (studio-verified ground truth)
 *   - source = getsongbpm → keep current unless ReccoBeats disagrees
 *                            AND the disagreement is NOT a 2:1 / 1:2 ratio
 *   - source = songstats  → same rule (replace on non-harmonic disagreement)
 *   - bpm missing         → take ReccoBeats
 *
 * Danceability: always replace (no harmonic ambiguity on a 0-1 scale).
 * Popularity:   new field, set whenever ReccoBeats returns one (0-100).
 */

import fs from "fs";

const KNOWN_FILE = "./knownTracks.json";
const BACKUP_FILE = `./knownTracks.bak.${Date.now()}.json`;
const THROTTLE_MS = 120;
const LOOKUP_BATCH = 30;
const FEATURES_BATCH = 20;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function normalizeBpm(value) {
  let v = Number(value);
  if (!v) return null;
  if (v > 180) v = v / 2;
  if (v < 70) v = v * 2;
  return Math.round(v);
}

async function lookupReccoBeats(spotifyIds) {
  const url = `https://api.reccobeats.com/v1/track?ids=${spotifyIds.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) return new Map();
  const data = await res.json();
  const out = new Map();
  for (const t of data.content || []) {
    const sid = (t.href || "").split("/track/")[1];
    if (sid) out.set(sid, { rbId: t.id, popularity: t.popularity ?? null });
  }
  return out;
}

async function audioFeaturesBatch(rbIds) {
  const url = `https://api.reccobeats.com/v1/audio-features?ids=${rbIds.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) return new Map();
  const data = await res.json();
  const out = new Map();
  for (const f of data.content || []) {
    if (f?.id) out.set(f.id, f);
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Returns { bpm, source, reason } describing what to store for this track.
 */
function decideBpm(current, currentSource, reccoBpm) {
  if (reccoBpm == null) {
    return { bpm: current, source: currentSource, reason: "no-recco-data" };
  }
  if (!current) {
    return { bpm: reccoBpm, source: "reccobeats", reason: "fill-missing" };
  }
  if (currentSource === "djay_pro") {
    return { bpm: current, source: currentSource, reason: "djay-verified" };
  }
  const ratio = reccoBpm / current;
  const isHarmonic =
    (ratio >= 0.45 && ratio <= 0.55) || (ratio >= 1.85 && ratio <= 2.15);
  if (isHarmonic) {
    return { bpm: current, source: currentSource, reason: "harmonic-ambiguity-keep" };
  }
  if (Math.abs(reccoBpm - current) <= 3) {
    return { bpm: current, source: currentSource, reason: "close-enough" };
  }
  // Non-harmonic disagreement → take ReccoBeats
  return { bpm: reccoBpm, source: "reccobeats", reason: "non-harmonic-disagree" };
}

async function main() {
  const tracks = readJson(KNOWN_FILE);
  const eligible = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.spotifyId);

  console.log(`Total catalogue : ${tracks.length}`);
  console.log(`Avec spotifyId  : ${eligible.length}`);
  console.log(`Throttle        : ${THROTTLE_MS} ms`);
  console.log("");

  fs.copyFileSync(KNOWN_FILE, BACKUP_FILE);
  console.log(`💾 Backup : ${BACKUP_FILE}\n`);

  // Phase 1: spotifyId → ReccoBeats UUID + popularity
  console.log("=== Phase 1 : résolution UUIDs ReccoBeats ===");
  const spToRb = new Map();
  const lookupChunks = chunk(eligible, LOOKUP_BATCH);
  for (let c = 0; c < lookupChunks.length; c++) {
    const ids = lookupChunks[c].map(({ t }) => t.spotifyId);
    const map = await lookupReccoBeats(ids);
    for (const [k, v] of map.entries()) spToRb.set(k, v);
    if ((c + 1) % 10 === 0 || c === lookupChunks.length - 1) {
      console.log(`[lookup] ${(c + 1) * LOOKUP_BATCH}/${eligible.length} · résolus=${spToRb.size}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`→ ${spToRb.size} tracks trouvées dans ReccoBeats\n`);

  // Phase 2: ReccoBeats UUID → audio features (batch 20)
  console.log("=== Phase 2 : récupération audio-features ===");
  const rbToFeat = new Map();
  const allRbIds = [...spToRb.values()].map((v) => v.rbId);
  const featChunks = chunk(allRbIds, FEATURES_BATCH);
  for (let c = 0; c < featChunks.length; c++) {
    const map = await audioFeaturesBatch(featChunks[c]);
    for (const [k, v] of map.entries()) rbToFeat.set(k, v);
    if ((c + 1) % 10 === 0 || c === featChunks.length - 1) {
      console.log(`[features] ${(c + 1) * FEATURES_BATCH}/${allRbIds.length} · reçus=${rbToFeat.size}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`→ ${rbToFeat.size} audio-features récupérés\n`);

  // Phase 3: apply policy
  console.log("=== Phase 3 : application des règles ===");
  const stats = {
    bpmKept_djay: 0,
    bpmKept_harmonic: 0,
    bpmKept_close: 0,
    bpmReplaced_nonHarmonic: 0,
    bpmFilled: 0,
    bpmNoData: 0,
    danceUpdated: 0,
    popularityAdded: 0,
  };
  const bpmReplacements = []; // for the top-N report

  for (const { t, i } of eligible) {
    const info = spToRb.get(t.spotifyId);
    if (!info) continue;
    const f = rbToFeat.get(info.rbId);

    const updated = { ...t };
    let changed = false;

    // ----- BPM -----
    if (f?.tempo != null) {
      const reccoBpm = normalizeBpm(f.tempo);
      const decision = decideBpm(t.bpm, t.source, reccoBpm);
      if (decision.bpm !== t.bpm) {
        bpmReplacements.push({
          before: t.bpm, after: decision.bpm,
          source: t.source, reason: decision.reason,
          artist: t.artist, title: t.title,
        });
        updated.bpm = decision.bpm;
        updated.bpmSource = decision.source;
        if (decision.reason === "fill-missing") stats.bpmFilled++;
        else stats.bpmReplaced_nonHarmonic++;
        changed = true;
      } else {
        switch (decision.reason) {
          case "djay-verified": stats.bpmKept_djay++; break;
          case "harmonic-ambiguity-keep": stats.bpmKept_harmonic++; break;
          case "close-enough": stats.bpmKept_close++; break;
        }
      }
    } else {
      stats.bpmNoData++;
    }

    // ----- Danceability -----
    if (f?.danceability != null) {
      if (t.danceability !== f.danceability) {
        updated.danceability = f.danceability;
        updated.danceabilitySource = "reccobeats";
        stats.danceUpdated++;
        changed = true;
      } else if (!t.danceabilitySource) {
        // value identical but we still want to mark the provenance
        updated.danceabilitySource = "reccobeats";
        changed = true;
      }
    }

    // ----- Popularity -----
    if (info.popularity != null && t.popularity !== info.popularity) {
      updated.popularity = info.popularity;
      stats.popularityAdded++;
      changed = true;
    }

    if (changed) tracks[i] = updated;
  }

  writeJson(KNOWN_FILE, tracks);

  console.log("");
  console.log("=== Résumé BPM ===");
  console.log(`  Conservés (djay_pro / studio)        : ${stats.bpmKept_djay}`);
  console.log(`  Conservés (ambiguïté harmonique 2:1) : ${stats.bpmKept_harmonic}`);
  console.log(`  Conservés (écart ≤ 3 BPM)            : ${stats.bpmKept_close}`);
  console.log(`  Remplacés (vrai désaccord)           : ${stats.bpmReplaced_nonHarmonic}`);
  console.log(`  Renseignés (BPM manquant)            : ${stats.bpmFilled}`);
  console.log(`  Sans donnée ReccoBeats               : ${stats.bpmNoData}`);
  console.log("");
  console.log(`Danceability mises à jour : ${stats.danceUpdated}`);
  console.log(`Popularity ajoutés        : ${stats.popularityAdded}`);
  console.log("");
  console.log("Top 20 vrais remplacements BPM (non harmoniques) :");
  bpmReplacements
    .filter((r) => r.reason === "non-harmonic-disagree")
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 20)
    .forEach((r) => {
      console.log(`  [${(r.source || "?").padEnd(11)}] ${String(r.before).padStart(3)} → ${String(r.after).padEnd(3)} · ${r.artist} — ${r.title}`);
    });
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
