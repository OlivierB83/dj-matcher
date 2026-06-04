/**
 * dedup-versions.js
 *
 * Cleans up duplicate version entries in knownTracks.json. Same track,
 * same artist, different cut — for example:
 *
 *   "Helmut Fritz — Ça m'énerve"
 *   "Helmut Fritz — Ça m'énerve - Radio Edit"
 *
 * → keep one entry, drop the others. We pick the survivor by metadata
 * completeness (spotifyId, image, genres, danceability, popularity) and
 * fall back to popularity then shorter title.
 *
 * NAMED remixes ("Prayer In C - Robin Schulz Remix", "Some Track - DJ X
 * Remix") are intentionally preserved — they're distinct artistic works,
 * and they usually carry a different artist string anyway so they wouldn't
 * group together in the first place. We only strip generic version
 * suffixes (Radio Edit, Extended Mix, Remastered YYYY, etc.).
 *
 * Usage :
 *   node dedup-versions.js            # preview
 *   node dedup-versions.js --commit   # apply (writes timestamped backup)
 */

import fs from "fs";
import { canonicalKey } from "./track-identity.js";

const KNOWN_FILE = "./knownTracks.json";

const commit = process.argv.includes("--commit");

// BPM + key authority: djay is the ground-truth Mixed-In-Key algorithm,
// so a djay-sourced entry always wins the BPM + key columns even when
// another entry in the group has richer auxiliary metadata. The
// remaining columns are then merged across the group — see mergeGroup.
function sourceRank(entry) {
  const s = entry.bpmSource || entry.source || "";
  if (s === "djay_pro_ax") return 100;
  if (s === "djay_pro") return 90;
  if (s === "reccobeats") return 50;
  if (s === "getsongbpm") return 40;
  if (s === "songstats") return 30;
  return 10;
}

/**
 * Merge a group of duplicate entries into one. Result is written at the
 * authority's catalog index; the other indices are scheduled for removal.
 *
 *   BPM, key, bpmSource, keySource, source ← the highest-rank entry
 *   title                                  ← shortest (= most canonical)
 *   artist                                 ← authority's artist
 *   everything else (spotifyId, album, year, image, genres,
 *   genresSource, danceability, danceabilitySource, popularity, isrc)
 *                                          ← first non-empty across the
 *                                            group (authority first,
 *                                            then ranked descending)
 */
function mergeGroup(entries) {
  const ranked = entries.slice().sort((a, b) => sourceRank(b) - sourceRank(a));
  const authority = ranked[0];

  const merged = {
    ...authority,
    bpm: authority.bpm,
    key: authority.key,
    bpmSource: authority.bpmSource || authority.source,
    keySource: authority.keySource || authority.source,
    source: authority.source,
  };

  const FILLABLE = [
    "spotifyId",
    "album",
    "year",
    "image",
    "genres",
    "genresSource",
    "danceability",
    "danceabilitySource",
    "popularity",
    "isrc",
  ];
  for (const e of ranked) {
    for (const k of FILLABLE) {
      const hasValue = merged[k] != null
        && !(Array.isArray(merged[k]) && merged[k].length === 0);
      const eHasValue = e[k] != null
        && !(Array.isArray(e[k]) && e[k].length === 0);
      if (!hasValue && eHasValue) merged[k] = e[k];
    }
  }

  // Shortest title across the group wins (Ça m'énerve > Ça m'énerve - Radio Edit)
  const shortestTitle = ranked
    .map((e) => e.title)
    .sort((a, b) => a.length - b.length)[0];
  merged.title = shortestTitle;
  merged.artist = authority.artist;

  return { merged, authorityIdx: authority._idx };
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));

  const groups = new Map(); // canonicalKey → catalog indices
  catalog.forEach((entry, i) => {
    if (!entry.artist || !entry.title) return;
    const k = canonicalKey(entry.artist, entry.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });

  const dupGroups = [...groups.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([k, indices]) => ({ k, indices }));

  const toRemove = new Set();
  const merges = new Map(); // authority idx → merged entry
  const decisions = []; // { keeper, losers } for the report

  for (const { indices } of dupGroups) {
    const entries = indices.map((i) => ({ ...catalog[i], _idx: i }));
    const { merged, authorityIdx } = mergeGroup(entries);
    merges.set(authorityIdx, merged);
    for (const e of entries) {
      if (e._idx === authorityIdx) continue;
      toRemove.add(e._idx);
    }
    decisions.push({
      keeper: merged,
      authorityIdx,
      losers: entries.filter((e) => e._idx !== authorityIdx),
    });
  }

  console.log("=== Bilan dédup versions ===");
  console.log(`Catalogue                     : ${catalog.length} entrées`);
  console.log(`Groupes en doublon (>1 version) : ${dupGroups.length}`);
  console.log(`Entrées à supprimer           : ${toRemove.size}`);
  console.log(`Après dédup                   : ${catalog.length - toRemove.size}`);

  if (decisions.length) {
    console.log(`\nÉchantillon (max 25) :`);
    decisions.slice(0, 25).forEach(({ keeper, losers }) => {
      console.log(
        `  KEEP  · [${keeper.bpmSource || keeper.source || "?"}] ${keeper.bpm}/${keeper.key}  ${keeper.artist} — ${keeper.title}`
      );
      losers.forEach((l) =>
        console.log(
          `  DROP  · [${l.bpmSource || l.source || "?"}] ${l.bpm}/${l.key}  ${l.artist} — ${l.title}`
        )
      );
      console.log(`  ---`);
    });
  }

  if (!commit) {
    if (toRemove.size) {
      console.log(`\nMode preview. Pour appliquer : node dedup-versions.js --commit`);
    }
    return;
  }

  if (!toRemove.size) {
    console.log(`\nRien à faire.`);
    return;
  }

  const backup = `./knownTracks.bak.dedup.${Date.now()}.json`;
  fs.copyFileSync(KNOWN_FILE, backup);
  // First overwrite each authority entry with its merged version, then
  // filter out the indices marked for removal. Doing it in that order is
  // important: the indices were captured against the original array.
  for (const [idx, merged] of merges.entries()) {
    catalog[idx] = merged;
  }
  const newCatalog = catalog.filter((_, i) => !toRemove.has(i));
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(newCatalog, null, 2));
  console.log(`\n💾 Backup : ${backup}`);
  console.log(`✓ Catalogue : ${catalog.length} → ${newCatalog.length} (-${toRemove.size})`);
}

main();
