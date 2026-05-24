import { useEffect, useMemo, useRef, useState } from "react";

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
  if (
    a === undefined ||
    a === null ||
    b === undefined ||
    b === null
  ) {
    return 0;
  }

  const diff = Math.abs(Number(a) - Number(b));

  if (diff <= 0.05) return maxPoints;
  if (diff <= 0.1) return Math.round(maxPoints * 0.75);
  if (diff <= 0.2) return Math.round(maxPoints * 0.4);

  return 0;
}

function genreScore(currentGenres, candidateGenres) {
  if (
    !Array.isArray(currentGenres) ||
    !Array.isArray(candidateGenres)
  ) {
    return 0;
  }

  const current = currentGenres.map((g) =>
    String(g).toLowerCase()
  );

  const candidate = candidateGenres.map((g) =>
    String(g).toLowerCase()
  );

  return current.some((g) => candidate.includes(g))
    ? 10
    : 0;
}

function yearScore(currentYear, candidateYear) {
  if (!currentYear || !candidateYear) return 0;

  const diff = Math.abs(
    Number(currentYear) - Number(candidateYear)
  );

  if (diff <= 3) return 8;
  if (diff <= 8) return 5;
  if (diff <= 15) return 2;

  return 0;
}

function scoreTrack(current, candidate) {
  let rawScore = 0;
  const reasons = [];

  const bpmDiff = Math.abs(
    Number(current.bpm) - Number(candidate.bpm)
  );

  if (bpmDiff <= 2) {
    rawScore += 40;
    reasons.push("BPM parfait");
  } else if (bpmDiff <= 5) {
    rawScore += 30;
    reasons.push("BPM proche");
  } else if (bpmDiff <= 10) {
    rawScore += 12;
    reasons.push("BPM acceptable");
  }

  const harmonyScore = keyScore(
    toCamelot(current.key),
    toCamelot(candidate.key)
  );

  rawScore += harmonyScore;

  if (harmonyScore >= 35) {
    reasons.push("même tonalité");
  } else if (harmonyScore >= 20) {
    reasons.push("harmonie compatible");
  } else if (harmonyScore > 0) {
    reasons.push("harmonie éloignée");
  }

  const genrePoints = genreScore(
    current.genres,
    candidate.genres
  );

  rawScore += genrePoints;

  if (genrePoints > 0) {
    reasons.push("style proche");
  }

  const yearPoints = yearScore(
    current.year,
    candidate.year
  );

  rawScore += yearPoints;

  if (yearPoints >= 5) {
    reasons.push("époque proche");
  }

  const dancePoints = closeScore(
    current.danceability,
    candidate.danceability,
    7
  );

  rawScore += dancePoints;

  if (dancePoints >= 5) {
    reasons.push("dance proche");
  }

  const score = Math.min(100, rawScore);

  return {
    ...candidate,
    rawScore,
    score,
    camelot: toCamelot(candidate.key),
    reason:
      reasons.join(" · ") || "compatibilité faible",
  };
}

function formatGenres(genres) {
  if (!Array.isArray(genres) || genres.length === 0) {
    return "?";
  }

  return genres.join(", ");
}

function formatDance(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "?";
  }

  return `${Math.round(Number(value) * 100)}%`;
}

function renderReasonTags(reasonText, isFavorite) {
  const parts = reasonText ? reasonText.split(" · ") : [];

  if (!isFavorite && parts.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 6,
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        justifyContent: "center",
      }}
    >
      {isFavorite && (
        <span
          style={{
            padding: "4px 8px",
            borderRadius: 12,
            fontWeight: "bold",
            fontSize: 12,
            background: "#ffd6e8",
            color: "#a8225d",
          }}
        >
          ♥ favori
        </span>
      )}

      {parts.map((part, index) => {
        const lower = part.toLowerCase();

        const excellent =
          lower.includes("parfait") ||
          lower.includes("même tonalité");

        const good =
          !excellent &&
          (lower.includes("bpm proche") ||
            lower.includes("harmonie compatible"));

        let bg = "#efefef";
        let color = "#444";

        if (excellent) {
          bg = "#d4f8d4";
          color = "#117a11";
        } else if (good) {
          bg = "#eaf6ea";
          color = "#3a8a3a";
        }

        return (
          <span
            key={index}
            style={{
              padding: "4px 8px",
              borderRadius: 12,
              fontWeight: "bold",
              fontSize: 12,
              background: bg,
              color,
            }}
          >
            {part}
          </span>
        );
      })}
    </div>
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
  const [view, setView] = useState("main");
  const [forgetStack, setForgetStack] = useState([]);

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const autocompleteBlurTimer = useRef(null);

  function forgetTrack(key) {
    setHidden((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      persistSet(STORAGE_HIDDEN, next);
      return next;
    });
    setForgetStack((prev) => [...prev, key]);
  }

  function restoreTrack(key) {
    setHidden((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      persistSet(STORAGE_HIDDEN, next);
      return next;
    });
    setForgetStack((prev) => prev.filter((k) => k !== key));
  }

  function undoLastForget() {
    if (forgetStack.length === 0) return;
    const lastKey = forgetStack[forgetStack.length - 1];
    restoreTrack(lastKey);
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
        return {
          ...track,
          enriched: false,
          enrichMessage:
            data.message || "non trouvé",
        };
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
      return {
        ...track,
        enriched: false,
        enrichMessage:
          "erreur enrichissement",
      };
    }
  }

  async function searchSpotify() {
    if (!query.trim()) return;

    setCurrent(null);
    setStatus("Recherche...");
    setSpotifyResults([]);

    try {
      const localRes = await fetch(
        `${API}/api/local-search?q=${encodeURIComponent(
          query
        )}`
      );

      const localData = await localRes.json();

      const localItems = localData.map(
        (track, index) => ({
          id: `local-${index}-${track.title}-${track.artist}`,
          name: track.title,
          artists: [{ name: track.artist }],
          album: {
            name: track.album || "",
            release_date: track.year || "",
            images: track.image
              ? [
                  { url: track.image },
                  { url: track.image },
                  { url: track.image },
                ]
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
        })
      );

      const spotifyRes = await fetch(
        `${API}/api/search?q=${encodeURIComponent(
          query
        )}`
      );

      const spotifyData =
        await spotifyRes.json();

      const spotifyItems =
        spotifyData.tracks?.items || [];

      const localKeys = new Set(
        localItems.map(
          (t) =>
            `${t.name?.toLowerCase()}|||${t.artists?.[0]?.name?.toLowerCase()}`
        )
      );

      const spotifyFiltered =
        spotifyItems.filter((t) => {
          const key = `${t.name?.toLowerCase()}|||${t.artists?.[0]?.name?.toLowerCase()}`;

          return !localKeys.has(key);
        });

      const enrichedSpotifyItems =
        await Promise.all(
          spotifyFiltered.map(enrichTrack)
        );

      const mergedItems = [
        ...localItems,
        ...enrichedSpotifyItems,
      ];

      setSpotifyResults(mergedItems);

      await loadKnownTracks();

      setStatus(
        `${mergedItems.length} résultats`
      );
    } catch (error) {
      console.error(error);
      setStatus(
        "Erreur pendant la recherche."
      );
    }
  }

  function selectTrack(track) {
    setStatus("");

    setCurrent({
      artist:
        track.artists?.[0]?.name ||
        track.artist,
      title: track.name || track.title,
      album:
        track.album?.name || track.album,
      image:
        track.album?.images?.[2]?.url ||
        track.image,
      year:
        track.year ||
        track.album?.release_date?.slice(
          0,
          4
        ),
      bpm: track.bpm,
      key: track.key,
      danceability:
        track.danceability,
      genres: track.genres,
      source: track.source,
    });

    setSpotifyResults([]);
    setQuery("");

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
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
        matches.push(t);
      }
    }

    return matches;
  }, [query, knownTracks]);

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "Arial",
        maxWidth: 1100,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div />

        <h1 style={{ margin: 0, textAlign: "center" }}>DJ Matcher V7.1 🎧</h1>

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          {forgetStack.length > 0 && (
            <button
              type="button"
              onClick={undoLastForget}
              title="Restaurer le dernier titre oublié"
              style={{
                padding: "6px 10px",
                border: "1px solid #ccc",
                background: "white",
                color: "#444",
                cursor: "pointer",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              ↶ Annuler ({forgetStack.length})
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              setView((v) => (v === "forgotten" ? "main" : "forgotten"))
            }
            style={{
              padding: "6px 10px",
              border: "1px solid #ccc",
              background: view === "forgotten" ? "#2962ff" : "white",
              color: view === "forgotten" ? "white" : "#444",
              cursor: "pointer",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {view === "forgotten"
              ? "← Retour"
              : `Titres oubliés (${hidden.size})`}
          </button>
        </div>
      </div>

      {view === "forgotten" ? (
        <>
          <h2>Titres oubliés</h2>

          {forgottenTracks.length === 0 ? (
            <p style={{ color: "#666" }}>
              Aucun titre oublié pour l'instant. Quand tu cliques sur "Oublier"
              sur une suggestion, elle apparaît ici et tu peux la restaurer.
            </p>
          ) : (
            forgottenTracks.map((t, index) => {
              const key = trackKey(t.artist, t.title);
              return (
                <div
                  key={`${key}-${index}`}
                  style={{
                    border: "1px solid #ddd",
                    padding: 10,
                    marginBottom: 8,
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  {t.image && (
                    <img
                      src={t.image}
                      width="60"
                      height="60"
                      alt=""
                      style={{ objectFit: "cover", borderRadius: 6 }}
                    />
                  )}

                  <div style={{ flex: 1 }}>
                    <strong>{t.title}</strong> — {t.artist}
                    <br />
                    <span style={{ fontSize: 12, color: "#666" }}>
                      BPM : {t.bpm || "?"} · Key : {t.key || "?"} · Style :{" "}
                      {formatGenres(t.genres)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => restoreTrack(key)}
                    style={{ padding: "6px 12px" }}
                  >
                    Restaurer
                  </button>
                </div>
              );
            })
          )}
        </>
      ) : (
        <>
          <h2>Recherche Spotify</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setAutocompleteOpen(false);
          searchSpotify();
        }}
        style={{ position: "relative", display: "inline-block" }}
      >
        <input
          autoFocus
          placeholder="Daft Punk, Rihanna, Pitbull..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setAutocompleteOpen(true);
          }}
          onFocus={() => {
            if (autocompleteBlurTimer.current) {
              clearTimeout(autocompleteBlurTimer.current);
            }
            setAutocompleteOpen(true);
          }}
          onBlur={() => {
            autocompleteBlurTimer.current = setTimeout(
              () => setAutocompleteOpen(false),
              150
            );
          }}
          style={{
            padding: 8,
            width: 340,
          }}
        />

        <button
          type="submit"
          style={{
            marginLeft: 8,
            padding: 8,
          }}
        >
          Rechercher
        </button>

        {autocompleteOpen && autocompleteMatches.length > 0 && (
          <ul
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              width: 340,
              margin: 0,
              padding: 0,
              listStyle: "none",
              background: "white",
              border: "1px solid #ddd",
              borderTop: "none",
              boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
              zIndex: 10,
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {autocompleteMatches.map((t, i) => (
              <li
                key={`${t.artist}-${t.title}-${i}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectTrack({
                    id: `local-ac-${i}`,
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
                  setAutocompleteOpen(false);
                }}
                style={{
                  padding: "6px 10px",
                  cursor: "pointer",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: 13,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "#f5f5f5")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "white")
                }
              >
                <strong>{t.title}</strong> — {t.artist}
                {t.bpm && t.key && (
                  <span style={{ color: "#888", marginLeft: 6 }}>
                    · {t.bpm} BPM · {toCamelot(t.key) || t.key}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </form>

      {status && (
        <p
          style={{
            background: "#f3f3f3",
            padding: 10,
          }}
        >
          {status}
        </p>
      )}

      {spotifyResults.length > 0 && (
        <>
          <h2>Résultats Spotify</h2>

          {spotifyResults.map((track) => (
            <div
              key={track.id}
              style={{
                border: "1px solid #ddd",
                padding: 10,
                marginBottom: 10,
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              {track.album?.images?.[2]
                ?.url && (
                <img
                  src={
                    track.album.images[2]
                      .url
                  }
                  width="50"
                  alt=""
                />
              )}

              <div style={{ flex: 1 }}>
                <strong>{track.name}</strong>{" "}
                —{" "}
                {
                  track.artists?.[0]
                    ?.name
                }
                <br />
                {track.album?.name}
                <br />

                {track.bpm &&
                track.key ? (
                  <>
                    BPM : {track.bpm} ·
                    Key : {track.key} ·
                    Camelot :{" "}
                    {toCamelot(
                      track.key
                    ) || "?"}{" "}
                    · Année :{" "}
                    {track.year ||
                      track.album?.release_date?.slice(
                        0,
                        4
                      ) ||
                      "?"}
                    <br />
                    Style :{" "}
                    {formatGenres(
                      track.genres
                    )}{" "}
                    · Dance :{" "}
                    {formatDance(
                      track.danceability
                    )}
                    <br />
                    Source :{" "}
                    {track.source}
                  </>
                ) : (
                  <>
                    Non enrichi ·{" "}
                    {track.enrichMessage ||
                      "hors catalogue"}
                  </>
                )}
              </div>

              <button
                onClick={() =>
                  selectTrack(track)
                }
                disabled={
                  !track.bpm ||
                  !track.key
                }
              >
                Utiliser
              </button>
            </div>
          ))}
        </>
      )}

      {current && (
        <>
          <h2>Morceau courant</h2>

          <div
            style={{
              border:
                "2px solid black",
              padding: 12,
            }}
          >
            {current.image && (
              <img
                src={current.image}
                width="80"
                alt=""
              />
            )}

            <p>
              <strong>
                {current.title}
              </strong>{" "}
              — {current.artist}
              <br />
              BPM : {current.bpm || "?"} ·
              Key : {current.key || "?"} ·
              Camelot :{" "}
              {toCamelot(
                current.key
              ) || "?"}{" "}
              · Année :{" "}
              {current.year || "?"}
              <br />
              Style :{" "}
              {formatGenres(
                current.genres
              )}{" "}
              · Dance :{" "}
              {formatDance(
                current.danceability
              )}
            </p>
          </div>

          <h2>Suggestions</h2>

          {allScored.length > 0 && (
            <div
              style={{
                marginBottom: 12,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 12, color: "#666", marginRight: 4 }}>
                Filtrer par style :
              </span>

              {[...GENRE_FAMILIES.map((f) => f.id), FAMILY_SANS_GENRE, FAMILY_AUTRE]
                .filter((id) => (familyCounts.get(id) || 0) > 0)
                .map((id) => {
                  const active = activeFamilies.has(id);
                  const count = familyCounts.get(id) || 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleFamily(id)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 14,
                        border: active ? "1px solid #2962ff" : "1px solid #ccc",
                        background: active ? "#2962ff" : "white",
                        color: active ? "white" : "#444",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {FAMILY_LABELS[id] || id}{" "}
                      <span style={{ opacity: 0.7 }}>({count})</span>
                    </button>
                  );
                })}

              {activeFamilies.size > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveFamilies(new Set())}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 14,
                    border: "1px solid #ddd",
                    background: "white",
                    color: "#888",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Réinitialiser
                </button>
              )}
            </div>
          )}

          {suggestions.length === 0 && (
            <p>Pas encore de suggestions.</p>
          )}

          {suggestions.map((track, index) => {
            return (
              <div
                key={`${track.trackKey}-${index}`}
                style={{
                  border: track.isFavorite
                    ? "1px solid #ffb3d1"
                    : "1px solid #ddd",
                  padding: 10,
                  marginBottom: 8,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  background: track.isFavorite ? "#fff7fb" : "white",
                }}
              >
                {track.image && (
                  <img
                    src={track.image}
                    width="100"
                    height="100"
                    alt=""
                    style={{
                      objectFit: "cover",
                      borderRadius: 8,
                    }}
                  />
                )}

                <div style={{ flex: 1 }}>
                  <strong>{track.title}</strong> — {track.artist}
                  <br />
                  Score DJ Matcher : {track.score}/100
                  <br />
                  BPM : {track.bpm} · Key : {track.key} · Camelot :{" "}
                  {track.camelot || "?"} · Année : {track.year || "?"}
                  <br />
                  Style : {formatGenres(track.genres)} · Dance :{" "}
                  {formatDance(track.danceability)}
                  <br />
                  {renderReasonTags(track.reason, track.isFavorite)}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(track.trackKey)}
                    title={track.isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
                    style={{
                      padding: "4px 8px",
                      border: "1px solid #ddd",
                      background: track.isFavorite ? "#ffd6e8" : "white",
                      color: track.isFavorite ? "#a8225d" : "#888",
                      cursor: "pointer",
                      borderRadius: 6,
                      fontSize: 16,
                    }}
                  >
                    {track.isFavorite ? "♥" : "♡"}
                  </button>

                  <button
                    type="button"
                    onClick={() => forgetTrack(track.trackKey)}
                    title="Ne plus me proposer ce titre"
                    style={{
                      padding: "4px 8px",
                      border: "1px solid #ddd",
                      background: "white",
                      color: "#888",
                      cursor: "pointer",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  >
                    Oublier
                  </button>

                  <button
                    type="button"
                    onClick={() => selectTrack(track)}
                    style={{ padding: "4px 8px" }}
                  >
                    Choisir
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
        </>
      )}
    </div>
  );
}