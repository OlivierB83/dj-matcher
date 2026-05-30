import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Heart } from "lucide-react";
import {
  Header,
  SearchBar,
  CurrentTrack,
  SuggestionsHeader,
} from "./components/Layout";
import { TrackCard } from "./components/TrackCard";

import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/track-card.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

const MAX_SUGGESTIONS = 50;
const FAVORITE_RANKING_BOOST = 25;

const STORAGE_HIDDEN = "djmatcher.hidden";
const STORAGE_FAVORITES = "djmatcher.favorites";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(feat|ft|with)\.?\b.*$/i, "")
    .replace(/\b(remix|edit|version|mix|remastered)\b.*$/i, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function trackKey(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

const GENRE_FAMILIES = [
  { id: "house", label: "House", match: /\b(house|nu disco|balearic|slap house)\b/i },
  { id: "techno", label: "Techno", match: /\b(techno|rave|hypertechno|hardcore|mainstage)\b/i },
  { id: "trance", label: "Trance", match: /\b(trance|psytrance)\b/i },
  { id: "dnb", label: "D&B / Garage", match: /(drum.{0,3}bass|jungle|garage|dubstep|breakbeat)/i },
  { id: "edm", label: "EDM / Electro", match: /\b(edm|electro|electronic|electronica|electropop|dance|club|bass|chillwave|chillstep|dj tools)\b/i },
  { id: "disco-funk", label: "Disco / Funk", match: /\b(disco|funk|boogie|quiet storm)\b/i },
  { id: "pop", label: "Pop", match: /\bpop\b/i },
  { id: "hiphop", label: "Hip-Hop / Rap", match: /\b(hip ?hop|rap|trap|crunk)\b/i },
  { id: "rnb", label: "R&B / Soul", match: /(r ?& ?b|soul)/i },
  { id: "rock", label: "Rock", match: /\b(rock|punk|grunge|metal|new wave|indie sleaze|alternative)\b/i },
  { id: "latin", label: "Latin", match: /\b(latin|latino|reggaeton|perreo|pachanga|chicha|bachata|baile funk|salsa|merengue|cumbia|brazilian)\b/i },
  { id: "afro", label: "Afro", match: /\b(afro|amapiano|african)\b/i },
  { id: "reggae", label: "Reggae", match: /\b(reggae|dancehall|ska)\b/i },
  { id: "jazz-classical", label: "Jazz / Classique", match: /\b(jazz|blues|classical|soundtrack|musical|original score|early music|viennese|hollywood|orchestr|opera)\b/i },
  { id: "folk-country", label: "Folk / Country", match: /\b(folk|country|cowboy|singer.songwriter)\b/i },
  { id: "french", label: "Chanson FR", match: /\b(chanson|french|france|varit|variete)\b/i },
];

const FAMILY_SANS_GENRE = "_sansgenre";
const FAMILY_AUTRE = "_autre";

const CATCHALL_FAMILIES = new Set(["pop", "rock", "edm"]);
const SPECIFIC_FAMILIES = new Set([
  "trance",
  "dnb",
  "techno",
  "reggae",
  "latin",
  "afro",
  "disco-funk",
  "jazz-classical",
  "folk-country",
  "house",
  "hiphop",
  "rnb",
]);

const FAMILY_LABELS = Object.fromEntries(
  GENRE_FAMILIES.map((f) => [f.id, f.label])
);
FAMILY_LABELS[FAMILY_SANS_GENRE] = "Sans genre";
FAMILY_LABELS[FAMILY_AUTRE] = "Autre";

function trackFamilies(track) {
  const gs = track.genres;

  if (!Array.isArray(gs) || gs.length === 0) {
    return [FAMILY_SANS_GENRE];
  }

  const matched = new Set();

  for (const g of gs) {
    for (const family of GENRE_FAMILIES) {
      if (family.match.test(g)) matched.add(family.id);
    }
  }

  if (matched.size === 0) return [FAMILY_AUTRE];

  const hasSpecific = Array.from(matched).some((id) =>
    SPECIFIC_FAMILIES.has(id)
  );

  if (hasSpecific) {
    for (const id of Array.from(matched)) {
      if (CATCHALL_FAMILIES.has(id)) matched.delete(id);
    }
  }

  return Array.from(matched);
}

function dedupeKnownTracks(tracks) {
  if (!Array.isArray(tracks)) return [];

  const byKey = new Map();

  for (const t of tracks) {
    const key = trackKey(t.artist, t.title);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, t);
      continue;
    }

    const merged = { ...existing };
    if (!merged.image && t.image) merged.image = t.image;
    if ((!merged.genres || !merged.genres.length) && t.genres?.length) {
      merged.genres = t.genres;
    }
    if (!merged.bpm && t.bpm) merged.bpm = t.bpm;
    if (!merged.key && t.key) merged.key = t.key;
    if (!merged.danceability && t.danceability) merged.danceability = t.danceability;
    if (!merged.year && t.year) merged.year = t.year;
    if (!merged.album && t.album) merged.album = t.album;
    byKey.set(key, merged);
  }

  return Array.from(byKey.values());
}

function loadStoredSet(storageKey) {
  if (typeof window === "undefined") return new Set();

  try {
    const raw = window.localStorage.getItem(storageKey);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function persistSet(storageKey, set) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify(Array.from(set))
    );
  } catch {
    /* ignore quota errors */
  }
}

const keyMap = {
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

function toCamelot(key) {
  if (!key) return null;

  const cleaned = String(key).trim();

  if (/^[0-9]{1,2}[AB]$/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return keyMap[cleaned] || null;
}

function keyScore(a, b) {
  if (!a || !b) return 0;

  if (a === b) return 35;

  const n1 = parseInt(a, 10);
  const n2 = parseInt(b, 10);

  const l1 = a.slice(-1);
  const l2 = b.slice(-1);

  if (
    l1 === l2 &&
    (Math.abs(n1 - n2) === 1 || Math.abs(n1 - n2) === 11)
  ) {
    return 25;
  }

  if (n1 === n2 && l1 !== l2) {
    return 20;
  }

  return 5;
}

function closeScore(a, b, maxPoints = 10) {
  if (a == null || b == null) return 0;

  const diff = Math.abs(Number(a) - Number(b));

  if (diff <= 0.05) return maxPoints;
  if (diff <= 0.1) return Math.round(maxPoints * 0.75);
  if (diff <= 0.2) return Math.round(maxPoints * 0.4);

  return 0;
}

function genreScore(currentGenres, candidateGenres) {
  if (!Array.isArray(currentGenres) || !Array.isArray(candidateGenres)) {
    return 0;
  }

  const current = currentGenres.map((g) => String(g).toLowerCase());
  const candidate = candidateGenres.map((g) => String(g).toLowerCase());

  return current.some((g) => candidate.includes(g)) ? 10 : 0;
}

function yearScore(currentYear, candidateYear) {
  if (!currentYear || !candidateYear) return 0;

  const diff = Math.abs(Number(currentYear) - Number(candidateYear));

  if (diff <= 3) return 8;
  if (diff <= 8) return 5;
  if (diff <= 15) return 2;

  return 0;
}

function scoreTrack(current, candidate) {
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

function compatLevelFromKey(a, b) {
  if (!a || !b) return "far";
  if (a === b) return "perfect";

  const n1 = parseInt(a, 10);
  const n2 = parseInt(b, 10);
  const l1 = a.slice(-1);
  const l2 = b.slice(-1);

  if (
    l1 === l2 &&
    (Math.abs(n1 - n2) === 1 || Math.abs(n1 - n2) === 11)
  ) {
    return "close";
  }

  if (n1 === n2 && l1 !== l2) return "close";
  return "far";
}

function computeCompat(current, candidate) {
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

function dancePercent(value) {
  if (value == null || value === "") return null;
  return Math.round(Number(value) * 100);
}

function pickCover(track) {
  return (
    track.album?.images?.[0]?.url ||
    track.album?.images?.[1]?.url ||
    track.album?.images?.[2]?.url ||
    track.image ||
    null
  );
}

export default function App() {
  const [query, setQuery] = useState("");
  const [spotifyResults, setSpotifyResults] = useState([]);
  const [knownTracks, setKnownTracks] = useState([]);
  const [current, setCurrent] = useState(null);
  const [status, setStatus] = useState("");

  const [hidden, setHidden] = useState(() => loadStoredSet(STORAGE_HIDDEN));
  const [favorites, setFavorites] = useState(() => loadStoredSet(STORAGE_FAVORITES));
  const [activeFamilies, setActiveFamilies] = useState(() => new Set());
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  const [view, setView] = useState("main");
  const [history, setHistory] = useState([]);

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);

  function forgetTrack(key) {
    if (hidden.has(key)) return;
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(key);
      persistSet(STORAGE_HIDDEN, next);
      return next;
    });
    setHistory((h) => [...h, { type: "forget", key }]);
  }

  function restoreTrack(key) {
    setHidden((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      persistSet(STORAGE_HIDDEN, next);
      return next;
    });
    setHistory((h) => h.filter((e) => !(e.type === "forget" && e.key === key)));
  }

  function goBack() {
    if (history.length === 0) return;
    const last = history[history.length - 1];

    if (last.type === "select") {
      setCurrent(last.prevCurrent);
    } else if (last.type === "forget") {
      setHidden((prev) => {
        if (!prev.has(last.key)) return prev;
        const next = new Set(prev);
        next.delete(last.key);
        persistSet(STORAGE_HIDDEN, next);
        return next;
      });
    }

    setHistory((h) => h.slice(0, -1));
  }

  function toggleFavorite(key) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistSet(STORAGE_FAVORITES, next);
      return next;
    });
  }

  function toggleFamily(id) {
    setActiveFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function loadKnownTracks() {
    const res = await fetch(`${API}/api/known-tracks`);
    const data = await res.json();
    setKnownTracks(dedupeKnownTracks(data));
  }

  useEffect(() => {
    let active = true;

    fetch(`${API}/api/known-tracks`)
      .then((res) => res.json())
      .then((data) => {
        if (active) setKnownTracks(dedupeKnownTracks(data));
      });

    return () => {
      active = false;
    };
  }, []);

  async function enrichTrack(track) {
    try {
      const res = await fetch(
        `${API}/api/enrich?artist=${encodeURIComponent(
          track.artists?.[0]?.name || ""
        )}&title=${encodeURIComponent(track.name)}`
      );

      const data = await res.json();

      if (!data.found) {
        return { ...track, enriched: false, enrichMessage: data.message || "non trouvé" };
      }

      return {
        ...track,
        bpm: data.bpm,
        key: data.key,
        danceability: data.danceability,
        genres: data.genres,
        year: data.year,
        source: data.source,
        enriched: true,
      };
    } catch {
      return { ...track, enriched: false, enrichMessage: "erreur enrichissement" };
    }
  }

  async function searchSpotify() {
    if (!query.trim()) return;

    setCurrent(null);
    setStatus("Recherche…");
    setSpotifyResults([]);
    setAutocompleteOpen(false);

    try {
      const localRes = await fetch(
        `${API}/api/local-search?q=${encodeURIComponent(query)}`
      );
      const localData = await localRes.json();

      const localItems = localData.map((track, index) => ({
        id: `local-${index}-${track.title}-${track.artist}`,
        name: track.title,
        artists: [{ name: track.artist }],
        album: {
          name: track.album || "",
          release_date: track.year || "",
          images: track.image
            ? [{ url: track.image }, { url: track.image }, { url: track.image }]
            : [],
        },
        bpm: track.bpm,
        key: track.key,
        danceability: track.danceability,
        genres: track.genres,
        year: track.year,
        source: track.source || "local",
        enriched: true,
        isLocal: true,
      }));

      const spotifyRes = await fetch(
        `${API}/api/search?q=${encodeURIComponent(query)}`
      );
      const spotifyData = await spotifyRes.json();
      const spotifyItems = spotifyData.tracks?.items || [];

      const localKeys = new Set(
        localItems.map(
          (t) =>
            `${t.name?.toLowerCase()}|||${t.artists?.[0]?.name?.toLowerCase()}`
        )
      );

      const spotifyFiltered = spotifyItems.filter((t) => {
        const key = `${t.name?.toLowerCase()}|||${t.artists?.[0]?.name?.toLowerCase()}`;
        return !localKeys.has(key);
      });

      const enrichedSpotifyItems = await Promise.all(
        spotifyFiltered.map(enrichTrack)
      );

      const mergedItems = [...localItems, ...enrichedSpotifyItems];

      setSpotifyResults(mergedItems);
      await loadKnownTracks();
      setStatus(`${mergedItems.length} résultats`);
    } catch (error) {
      console.error(error);
      setStatus("Erreur pendant la recherche.");
    }
  }

  function selectTrack(track) {
    setHistory((h) => [...h, { type: "select", prevCurrent: current }]);
    setStatus("");

    setCurrent({
      artist: track.artists?.[0]?.name || track.artist,
      title: track.name || track.title,
      album: track.album?.name || track.album,
      image: pickCover(track),
      year: track.year || track.album?.release_date?.slice(0, 4),
      bpm: track.bpm,
      key: track.key,
      danceability: track.danceability,
      genres: track.genres,
      source: track.source,
    });

    setSpotifyResults([]);
    setQuery("");
    setAutocompleteOpen(false);

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const allScored = useMemo(() => {
    if (!current || !current.bpm || !current.key) return [];

    const currentKey = trackKey(current.artist, current.title);

    return knownTracks
      .filter((t) => t.bpm && t.key)
      .filter((t) => trackKey(t.artist, t.title) !== currentKey)
      .map((t) => {
        const scored = scoreTrack(current, t);
        const key = trackKey(t.artist, t.title);
        const isFavorite = favorites.has(key);
        return {
          ...scored,
          trackKey: key,
          isFavorite,
          rankingScore: scored.score + (isFavorite ? FAVORITE_RANKING_BOOST : 0),
          families: trackFamilies(t),
          compat: computeCompat(current, t),
        };
      })
      .sort((a, b) => b.rankingScore - a.rankingScore);
  }, [current, knownTracks, favorites]);

  const familyCounts = useMemo(() => {
    const counts = new Map();

    allScored.forEach((t) => {
      if (hidden.has(t.trackKey)) return;
      t.families.forEach((f) =>
        counts.set(f, (counts.get(f) || 0) + 1)
      );
    });

    return counts;
  }, [allScored, hidden]);

  const suggestions = useMemo(() => {
    const filtered = allScored.filter((t) => {
      if (hidden.has(t.trackKey)) return false;
      if (activeFamilies.size === 0) return true;
      return t.families.some((f) => activeFamilies.has(f));
    });

    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [allScored, activeFamilies, hidden]);

  const forgottenTracks = useMemo(() => {
    if (hidden.size === 0) return [];
    return knownTracks
      .filter((t) => hidden.has(trackKey(t.artist, t.title)))
      .sort((a, b) =>
        String(a.artist || "").localeCompare(String(b.artist || ""))
      );
  }, [knownTracks, hidden]);

  const autocompleteMatches = useMemo(() => {
    const q = normalize(query);
    if (q.length < 2 || !knownTracks.length) return [];

    const matches = [];

    for (const t of knownTracks) {
      if (matches.length >= 8) break;
      const artist = normalize(t.artist);
      const title = normalize(t.title);
      if (artist.includes(q) || title.includes(q)) {
        matches.push({
          key: trackKey(t.artist, t.title),
          title: t.title,
          artist: t.artist,
          bpm: t.bpm,
          camelot: toCamelot(t.key),
          _track: t,
        });
      }
    }

    return matches;
  }, [query, knownTracks]);

  function selectFromAutocomplete(item) {
    const t = item._track;
    selectTrack({
      id: `local-ac-${item.key}`,
      name: t.title,
      artists: [{ name: t.artist }],
      album: {
        name: t.album || "",
        release_date: t.year || "",
        images: t.image
          ? [{ url: t.image }, { url: t.image }, { url: t.image }]
          : [],
      },
      bpm: t.bpm,
      key: t.key,
      danceability: t.danceability,
      genres: t.genres,
      year: t.year,
      source: t.source || "local",
      enriched: true,
      isLocal: true,
    });
  }

  /* ===== Forgotten view ===== */
  if (view === "forgotten") {
    return (
      <div className="app">
        <Header
          isForgottenView
          onBack={() => setView("main")}
        />

        <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 500 }}>
          Titres oubliés{" "}
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 15 }}>
            {forgottenTracks.length}
          </span>
        </h2>

        {forgottenTracks.length === 0 ? (
          <div className="forgotten-empty">
            Aucun titre oublié. Clique sur « oublier » sur une suggestion
            pour la retirer des propositions futures.
          </div>
        ) : (
          forgottenTracks.map((t) => {
            const key = trackKey(t.artist, t.title);
            return (
              <div key={key} className="forgotten-row">
                <div className="forgotten-cover">
                  {t.image ? <img src={t.image} alt="" /> : <span>🎵</span>}
                </div>
                <div className="forgotten-info">
                  <div className="forgotten-title">
                    {t.title} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>— {t.artist}</span>
                  </div>
                  <div className="forgotten-meta">
                    BPM {t.bpm || "?"} · KEY {t.key || "?"} ·{" "}
                    {(t.genres || []).join(", ") || "—"}
                  </div>
                </div>
                <button className="btn-restore" onClick={() => restoreTrack(key)}>
                  Restaurer
                </button>
              </div>
            );
          })
        )}
      </div>
    );
  }

  /* ===== Main view ===== */
  const currentForUI = current
    ? {
        title: current.title,
        artist: current.artist,
        bpm: current.bpm,
        key: current.key,
        camelot: toCamelot(current.key),
        year: current.year || null,
        coverUrl: current.image || null,
      }
    : null;

  const allFamilyIds = [
    ...GENRE_FAMILIES.map((f) => f.id),
    FAMILY_SANS_GENRE,
    FAMILY_AUTRE,
  ].filter((id) => (familyCounts.get(id) || 0) > 0);

  return (
    <div className="app">
      <Header
        forgottenCount={hidden.size}
        onOpenForgotten={() => setView("forgotten")}
        backCount={history.length}
        onBack={goBack}
      />

      <SearchBar
        value={query}
        onChange={(v) => {
          setQuery(v);
          setAutocompleteOpen(true);
        }}
        onSubmit={searchSpotify}
        autocomplete={{
          open: autocompleteOpen,
          items: autocompleteMatches,
          onFocus: () => setAutocompleteOpen(true),
          onBlur: () => setAutocompleteOpen(false),
          onSelect: selectFromAutocomplete,
        }}
      />

      {status && <div className="status-line">{status}</div>}

      {spotifyResults.length > 0 && (
        <>
          <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 500 }}>
            Résultats Spotify
          </h3>
          <div className="suggestions-list" style={{ marginBottom: 24 }}>
            {spotifyResults.map((t) => {
              const cover = pickCover(t);
              const enriched = !!(t.bpm && t.key);
              const artist = t.artists?.[0]?.name || "";
              const tKey = trackKey(artist, t.name);
              const isFav = enriched && favorites.has(tKey);
              return (
                <div
                  key={t.id}
                  className={`track-card${enriched ? " is-clickable" : ""}`}
                  onClick={enriched ? () => selectTrack(t) : undefined}
                  role={enriched ? "button" : undefined}
                  tabIndex={enriched ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (enriched && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      selectTrack(t);
                    }
                  }}
                  style={!enriched ? { opacity: 0.55 } : undefined}
                >
                  <div className="track-row">
                    <div className="track-cover">
                      {cover ? <img src={cover} alt="" /> : <span aria-hidden>🎵</span>}
                    </div>
                    <div className="track-info">
                      <div className="track-title">{t.name}</div>
                      <div className="track-artist">
                        {artist} · {t.album?.name}
                      </div>
                      <div className="meta-row">
                        {enriched ? (
                          <>
                            <span><span className="meta-label">BPM</span>{t.bpm}</span>
                            <span><span className="meta-label">KEY</span>{t.key}</span>
                            <span><span className="meta-label">CAMELOT</span>{toCamelot(t.key) || "?"}</span>
                            <span><span className="meta-label">YEAR</span>{t.year || t.album?.release_date?.slice(0, 4) || "?"}</span>
                          </>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>
                            Non enrichi · {t.enrichMessage || "hors catalogue"}
                          </span>
                        )}
                      </div>
                    </div>
                    {enriched && (
                      <button
                        className={`btn-fav${isFav ? " is-fav" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(tKey);
                        }}
                        aria-label={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
                      >
                        <Heart size={14} fill={isFav ? "currentColor" : "none"} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {currentForUI && (
        <>
          <CurrentTrack
            track={currentForUI}
            isFavorite={favorites.has(trackKey(current.artist, current.title))}
            onToggleFavorite={() =>
              toggleFavorite(trackKey(current.artist, current.title))
            }
          />

          <SuggestionsHeader
            count={suggestions.length}
            onFilter={() => setFiltersCollapsed((v) => !v)}
            filterLabel={
              filtersCollapsed
                ? `Filtrer par style${allFamilyIds.length > 0 ? ` (${allFamilyIds.length})` : ""}`
                : "Masquer les filtres"
            }
          />

          {!filtersCollapsed && allFamilyIds.length > 0 && (
            <div className="filter-chips">
              {allFamilyIds.map((id) => {
                const active = activeFamilies.has(id);
                const count = familyCounts.get(id) || 0;
                return (
                  <button
                    key={id}
                    className={`chip${active ? " is-active" : ""}`}
                    onClick={() => toggleFamily(id)}
                  >
                    {FAMILY_LABELS[id] || id}{" "}
                    <span className="chip-count">({count})</span>
                  </button>
                );
              })}
              {activeFamilies.size > 0 && (
                <button
                  className="chip chip-reset"
                  onClick={() => setActiveFamilies(new Set())}
                >
                  Réinitialiser
                </button>
              )}
            </div>
          )}

          {suggestions.length === 0 ? (
            <div className="suggestions-empty">
              Pas encore de suggestions.
            </div>
          ) : (
            <div className="suggestions-list">
              <AnimatePresence>
                {suggestions.map((t) => (
                  <TrackCard
                    key={t.trackKey}
                    track={{
                      id: t.trackKey,
                      title: t.title,
                      artist: t.artist,
                      coverUrl: t.image || null,
                      bpm: t.bpm,
                      key: t.key,
                      camelot: t.camelot,
                      year: t.year || null,
                      dance: dancePercent(t.danceability),
                      score: t.score,
                    }}
                    compat={t.compat}
                    featured={t.isFavorite}
                    isFavorite={t.isFavorite}
                    onChoose={() => selectTrack(t)}
                    onToggleFavorite={() => toggleFavorite(t.trackKey)}
                    onForget={() => forgetTrack(t.trackKey)}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </div>
  );
}
