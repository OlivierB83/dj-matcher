/**
 * scoring.js
 *
 * Pure JS scoring logic for DJ Matcher. The frontend (src/App.jsx) and
 * the backend (server.js) BOTH import from here so the suggestions
 * shown in the iOS app via /api/suggestions are computed with the same
 * rules as the suggestions shown in the web app. No React, no Node-only
 * deps — straight ESM so Vite and Express both pick it up.
 *
 * Score breakdown (max 100):
 *   - BPM proximity        ≤ 40
 *   - Key compatibility    ≤ 35 (Camelot wheel)
 *   - Genre overlap        ≤ 10 (≥ 1 shared genre)
 *   - Year proximity       ≤ 8
 *   - Danceability close   ≤ 7
 *
 * computeCompat() returns a "perfect / close / far" tag per dimension
 * (bpm, key, style, dance) for the UI badges. Same definitions as the
 * score, just expressed as labels.
 */

// Traditional → Camelot, including enharmonic spellings (Bb / Eb / Ab
// / Gb / Db). Slightly different from the table in track-identity.js
// because that one is keyed on the strings djay/Spotify hand us; this
// one is the matching-side normaliser.
export const keyMap = {
  C: "8B", Am: "8A",
  G: "9B", Em: "9A",
  D: "10B", Bm: "10A",
  A: "11B", "F#m": "11A",
  E: "12B", "C#m": "12A",
  B: "1B", "G#m": "1A",
  "F#": "2B", "D#m": "2A",
  "C#": "3B", "A#m": "3A",
  "G#": "4B", Fm: "4A",
  "D#": "5B", Cm: "5A",
  "A#": "6B", Gm: "6A",
  F: "7B", Dm: "7A",
  Bb: "6B", Eb: "5B", Ab: "4B",
  Gb: "2B", Db: "3B",
};

export function toCamelot(key) {
  if (!key) return null;
  const cleaned = String(key).trim();
  if (/^[0-9]{1,2}[AB]$/i.test(cleaned)) return cleaned.toUpperCase();
  return keyMap[cleaned] || null;
}

export function keyScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 35;

  const n1 = parseInt(a, 10);
  const n2 = parseInt(b, 10);
  const l1 = a.slice(-1);
  const l2 = b.slice(-1);

  // Adjacent on the wheel (same major/minor side)
  if (l1 === l2 && (Math.abs(n1 - n2) === 1 || Math.abs(n1 - n2) === 11)) {
    return 25;
  }
  // Relative major/minor (same number, different letter)
  if (n1 === n2 && l1 !== l2) return 20;
  return 5;
}

export function closeScore(a, b, maxPoints = 10) {
  if (a == null || b == null) return 0;
  const diff = Math.abs(Number(a) - Number(b));
  if (diff <= 0.05) return maxPoints;
  if (diff <= 0.1) return Math.round(maxPoints * 0.75);
  if (diff <= 0.2) return Math.round(maxPoints * 0.4);
  return 0;
}

export function genreScore(currentGenres, candidateGenres) {
  if (!Array.isArray(currentGenres) || !Array.isArray(candidateGenres)) return 0;
  const current = currentGenres.map((g) => String(g).toLowerCase());
  const candidate = candidateGenres.map((g) => String(g).toLowerCase());
  return current.some((g) => candidate.includes(g)) ? 10 : 0;
}

export function yearScore(currentYear, candidateYear) {
  if (!currentYear || !candidateYear) return 0;
  const diff = Math.abs(Number(currentYear) - Number(candidateYear));
  if (diff <= 3) return 8;
  if (diff <= 8) return 5;
  if (diff <= 15) return 2;
  return 0;
}

export function scoreTrack(current, candidate) {
  let rawScore = 0;

  const bpmDiff = Math.abs(Number(current.bpm) - Number(candidate.bpm));
  if (bpmDiff <= 2) rawScore += 40;
  else if (bpmDiff <= 5) rawScore += 30;
  else if (bpmDiff <= 10) rawScore += 12;

  rawScore += keyScore(toCamelot(current.key), toCamelot(candidate.key));
  rawScore += genreScore(current.genres, candidate.genres);
  rawScore += yearScore(current.year, candidate.year);
  rawScore += closeScore(current.danceability, candidate.danceability, 7);

  return {
    ...candidate,
    rawScore,
    score: Math.min(100, rawScore),
    camelot: toCamelot(candidate.key),
  };
}

export function compatLevelFromKey(a, b) {
  if (!a || !b) return "far";
  if (a === b) return "perfect";

  const n1 = parseInt(a, 10);
  const n2 = parseInt(b, 10);
  const l1 = a.slice(-1);
  const l2 = b.slice(-1);

  if (l1 === l2 && (Math.abs(n1 - n2) === 1 || Math.abs(n1 - n2) === 11)) {
    return "close";
  }
  if (n1 === n2 && l1 !== l2) return "close";
  return "far";
}

export function computeCompat(current, candidate) {
  const bpmDiff = Math.abs(Number(current.bpm) - Number(candidate.bpm));
  let bpm;
  if (bpmDiff <= 2) bpm = "perfect";
  else if (bpmDiff <= 5) bpm = "close";
  else bpm = "far";

  const key = compatLevelFromKey(
    toCamelot(current.key),
    toCamelot(candidate.key)
  );

  const curGenres = Array.isArray(current.genres)
    ? current.genres.map((g) => String(g).toLowerCase())
    : [];
  const candGenres = Array.isArray(candidate.genres)
    ? candidate.genres.map((g) => String(g).toLowerCase())
    : [];
  const sharedGenres = curGenres.filter((g) => candGenres.includes(g)).length;

  let style;
  if (sharedGenres >= 2) style = "perfect";
  else if (sharedGenres >= 1) style = "close";
  else style = "far";

  let dance;
  if (current.danceability == null || candidate.danceability == null) {
    dance = "far";
  } else {
    const diff = Math.abs(
      Number(current.danceability) - Number(candidate.danceability)
    );
    if (diff <= 0.05) dance = "perfect";
    else if (diff <= 0.1) dance = "close";
    else dance = "far";
  }

  return { bpm, key, camelot: key, style, dance };
}
