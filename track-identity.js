/**
 * track-identity.js
 *
 * Shared canonical-key logic. Used by every code path that needs to ask
 * "is this Spotify/djay track the same song as that other one?":
 *
 *   - dedup-versions.js   → merges multi-version duplicates in the catalog
 *   - djay-ax-import.js   → matches djay rows against the catalog (and
 *                            dedups the djay rows among themselves)
 *   - server.js           → /api/enrich looks up by canonical key
 *   - src/App.jsx         → dedupes the catalog client-side AND collapses
 *                            multi-version Spotify results into one card
 *
 * The "Helmut Fritz — Ça m'énerve" / "Ça m'énerve - Radio Edit" case is
 * the canonical example: same song, same artist, different release cut.
 * Named remixes ("Prayer In C - Robin Schulz Remix") are NOT stripped —
 * they're distinct artistic works.
 *
 * Pure JS / ESM only — no Node-specific imports — so this file imports
 * cleanly from both Node scripts and the Vite browser bundle.
 */

// Cosmetic version suffixes that don't change the underlying song.
// Conservative on purpose: bare "- Remix" / "- Mix" stays, because those
// typically signal a real different version (and usually a different
// artist string carries the remixer's name).
const SUFFIX_PATTERNS = [
  / - radio edit$/i,
  / - radio mix$/i,
  / - radio version$/i,
  / - radio cut$/i,
  / - single edit$/i,
  / - single version$/i,
  / - album version$/i,
  / - extended$/i,
  / - extended version$/i,
  / - extended mix$/i,
  / - original$/i,
  / - original mix$/i,
  / - original version$/i,
  / - remastered( \d{4})?$/i,
  / - remaster( \d{4})?$/i,
  / - remasteris[ée]e?( en \d{4})?$/i,
  / - \d{4} remaster(ed)?$/i,
  / - \d{4} remix$/i,
  / - mono( version)?$/i,
  / - stereo( version)?$/i,
  / - clean( version)?$/i,
  / - explicit( version)?$/i,
  / - bonus track$/i,
  / - from .+$/i,
  /\s*\(radio edit\)$/i,
  /\s*\(radio version\)$/i,
  /\s*\(extended mix\)$/i,
  /\s*\(extended version\)$/i,
  /\s*\(original mix\)$/i,
  /\s*\(single version\)$/i,
  /\s*\(album version\)$/i,
  /\s*\(remastered( \d{4})?\)$/i,
];

/** djay column-truncation marker, e.g. "Ça m'éner…" or "Ça m'éner...". */
export function stripTrunc(text) {
  return String(text || "").replace(/\s*[.…]{1,}$/u, "").trim();
}

/** Accent / case / punctuation strip. Preserves word order so that
 *  prefix matching still works (we don't kill "radio edit" suffixes
 *  here — coreTitle does that). */
export function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip the cosmetic version suffix from a raw title. "Ça m'énerve - Radio
 *  Edit" → "Ça m'énerve". Several passes so "Track - Radio Edit -
 *  Remastered 2020" collapses fully. */
export function coreTitle(title) {
  let t = String(title || "").trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const p of SUFFIX_PATTERNS) {
      const next = t.replace(p, "").trim();
      if (next !== t) {
        t = next;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return t;
}

/** The thing two records share when they're "the same song". */
export function canonicalKey(artist, title) {
  return normalize(artist) + "|" + normalize(coreTitle(stripTrunc(title)));
}

/** "Major Lazer, Justin Bieber, MØ" → "Major Lazer". The split delimiters
 *  cover every separator Spotify / djay use for collaborations. */
export function primaryArtist(s) {
  return String(s || "")
    .split(/,| & |\bfeat\.?|\bft\.?|\bwith\b|\bvs\.?/i)[0]
    .trim();
}
