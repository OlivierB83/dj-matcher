import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Header,
  SearchBar,
  CurrentTrack,
  SuggestionsHeader,
} from "./components/Layout";
import { TrackCard } from "./components/TrackCard";
import { SearchResultCard } from "./components/SearchResultCard";

import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/track-card.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

const MAX_SUGGESTIONS = 50;
const FAVORITE_RANKING_BOOST = 25;

// Aligned with VIRAL_THRESHOLD in TrackCard.jsx so a track that the
// "Populaires" filter shows is exactly a track that wears the buzz badge.
const POPULARITY_THRESHOLD = 75;

const STORAGE_HIDDEN = "djmatcher.hidden";
const STORAGE_FAVORITES = "djmatcher.favorites";
const STORAGE_FILTER_POPULAR = "djmatcher.filter.popular";
const STORAGE_FILTER_FAVORITES = "djmatcher.filter.favoritesOnly";

import { canonicalKey } from "../track-identity.js";
import {
  toCamelot,
  scoreTrack,
  computeCompat,
} from "../scoring.js";

// Local space-stripped normalise used by the substring search filters
// further down (e.g. typing "helmutfritz" should still hit "Helmut
// Fritz"). The "same song" question — which is structurally different,
// because it cares about version suffixes like "- Radio Edit" — is
// answered by trackKey via the shared canonicalKey helper.
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
  return canonicalKey(artist, title);
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

function loadStoredBool(storageKey) {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

function persistBool(storageKey, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value ? "1" : "0");
  } catch {
    /* ignore quota errors */
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

// keyMap, toCamelot, keyScore, closeScore, genreScore, yearScore,
// scoreTrack, compatLevelFromKey, computeCompat now live in
// ../scoring.js so the iOS app's /api/suggestions endpoint scores
// identically to the web UI. Imported above.

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
  const [showPopularOnly, setShowPopularOnly] = useState(() =>
    loadStoredBool(STORAGE_FILTER_POPULAR)
  );
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(() =>
    loadStoredBool(STORAGE_FILTER_FAVORITES)
  );
  const [view, setView] = useState("main");
  const [history, setHistory] = useState([]);

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [scrollToKey, setScrollToKey] = useState(null);

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
    // After the re-sort, scroll the track to its new position so the user
    // can see where it ended up.
    setScrollToKey(key);
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

  // Scroll to top after the new `current` track has been committed to the DOM
  // (doing it inside selectTrack races with the re-layout and can leave the
  // page stranded mid-scroll when the new content is shorter than the previous).
  useEffect(() => {
    if (!current) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, [current]);

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

      // Canonical-key dedup. Two-stage:
      //   1. drop Spotify results whose canonical key (= same song,
      //      ignoring "- Radio Edit", "- Extended Mix", etc.) is already
      //      represented in the local catalog
      //   2. collapse remaining Spotify versions of the same song into
      //      one card so the UI doesn't show "Ça m'énerve" AND
      //      "Ça m'énerve - Radio Edit" side by side
      const localCanonical = new Set(
        localItems.map((t) =>
          canonicalKey(t.artists?.[0]?.name || "", t.name || "")
        )
      );

      const seenCanonical = new Set(localCanonical);
      const spotifyFiltered = [];
      for (const t of spotifyItems) {
        const k = canonicalKey(t.artists?.[0]?.name || "", t.name || "");
        if (seenCanonical.has(k)) continue;
        seenCanonical.add(k);
        spotifyFiltered.push(t);
      }

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

  // Counts shown on the chips. We compute them against the family-filtered
  // list (so toggling a family also updates the popular/favorites counts),
  // but BEFORE the popular/favorites filter — otherwise the count would
  // always equal the suggestions length once the chip is active.
  const familyFilteredScored = useMemo(() => {
    return allScored.filter((t) => {
      if (hidden.has(t.trackKey)) return false;
      if (activeFamilies.size === 0) return true;
      return t.families.some((f) => activeFamilies.has(f));
    });
  }, [allScored, activeFamilies, hidden]);

  const popularCount = useMemo(
    () => familyFilteredScored.filter((t) => (t.popularity ?? -1) >= POPULARITY_THRESHOLD).length,
    [familyFilteredScored]
  );
  const favoritesCount = useMemo(
    () => familyFilteredScored.filter((t) => t.isFavorite).length,
    [familyFilteredScored]
  );

  const suggestions = useMemo(() => {
    // OR semantics: if both toggles are on, show tracks that are popular
    // OR favorite. If only one is on, that one alone applies. If neither
    // is on, no extra filter (same as before).
    const filtered = familyFilteredScored.filter((t) => {
      if (!showPopularOnly && !showFavoritesOnly) return true;
      const popOk = showPopularOnly && (t.popularity ?? -1) >= POPULARITY_THRESHOLD;
      const favOk = showFavoritesOnly && t.isFavorite;
      return popOk || favOk;
    });

    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [familyFilteredScored, showPopularOnly, showFavoritesOnly]);

  // After a favorite toggle, the re-ranked suggestions render AND framer-motion
  // animates the card to its new position (~300ms). We wait for that to settle,
  // then scroll the page so the moved card sits ~100px from the top — always
  // visibly moves so the user can confirm where the track landed.
  useEffect(() => {
    if (!scrollToKey) return;
    const t = setTimeout(() => {
      const el = document.querySelector(
        `[data-track-key="${CSS.escape(scrollToKey)}"]`
      );
      if (el) {
        const rect = el.getBoundingClientRect();
        const top = Math.max(0, rect.top + window.scrollY - 100);
        window.scrollTo({ top, behavior: "smooth" });
      }
      setScrollToKey(null);
    }, 380);
    return () => clearTimeout(t);
  }, [scrollToKey, suggestions]);

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
              const enriched = !!(t.bpm && t.key);
              const artist = t.artists?.[0]?.name || "";
              const tKey = trackKey(artist, t.name);
              const isFav = enriched && favorites.has(tKey);
              const normalized = {
                id: t.id,
                title: t.name,
                artist,
                album: t.album?.name,
                coverUrl: pickCover(t),
                bpm: t.bpm,
                key: t.key,
                camelot: toCamelot(t.key),
                year:
                  t.year || t.album?.release_date?.slice(0, 4) || null,
                genres: t.genres,
                popularity: t.popularity ?? null,
                enriched,
                enrichMessage: t.enrichMessage,
              };
              return (
                <SearchResultCard
                  key={t.id}
                  track={normalized}
                  isFavorite={isFav}
                  onChoose={() => selectTrack(t)}
                  onToggleFavorite={() => toggleFavorite(tKey)}
                />
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

          <div className="filter-chips filter-chips-top">
            <button
              className={`chip${showFavoritesOnly ? " is-active" : ""}`}
              onClick={() =>
                setShowFavoritesOnly((v) => {
                  const next = !v;
                  persistBool(STORAGE_FILTER_FAVORITES, next);
                  return next;
                })
              }
              title="N'afficher que les favoris"
            >
              ★ Favoris <span className="chip-count">({favoritesCount})</span>
            </button>
            <button
              className={`chip${showPopularOnly ? " is-active" : ""}`}
              onClick={() =>
                setShowPopularOnly((v) => {
                  const next = !v;
                  persistBool(STORAGE_FILTER_POPULAR, next);
                  return next;
                })
              }
              title={`N'afficher que les titres avec popularité Spotify ≥ ${POPULARITY_THRESHOLD}`}
            >
              🔥 Populaires <span className="chip-count">({popularCount})</span>
            </button>
          </div>

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
                      popularity: t.popularity ?? null,
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
