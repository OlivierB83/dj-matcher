import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

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

function renderReasonTags(reasonText) {
  if (!reasonText) return null;

  const parts = reasonText.split(" · ");

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
      {parts.map((part, index) => {
        const lower = part.toLowerCase();

        const excellent =
          lower.includes("parfait") ||
          lower.includes("même tonalité");

        return (
          <span
            key={index}
            style={{
              padding: "4px 8px",
              borderRadius: 12,
              fontWeight: "bold",
              fontSize: 12,
              background: excellent
                ? "#d4f8d4"
                : "#efefef",
              color: excellent
                ? "#117a11"
                : "#444",
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

  async function loadKnownTracks() {
    const res = await fetch(`${API}/api/known-tracks`);
    const data = await res.json();
    setKnownTracks(data);
  }

  useEffect(() => {
    loadKnownTracks();
  }, []);

  async function enrichTrack(track) {
    const isrc = track.external_ids?.isrc;

    if (!isrc) {
      return {
        ...track,
        enriched: false,
        enrichMessage: "pas d'ISRC",
      };
    }

    try {
      const res = await fetch(
        `${API}/api/enrich?artist=${encodeURIComponent(
          track.artists?.[0]?.name || ""
        )}&title=${encodeURIComponent(
          track.name
        )}&album=${encodeURIComponent(
          track.album?.name || ""
        )}&year=${encodeURIComponent(
          track.album?.release_date?.slice(0, 4) || ""
        )}&image=${encodeURIComponent(
          track.album?.images?.[2]?.url || ""
        )}&isrc=${encodeURIComponent(isrc)}`
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

  function useTrack(track) {
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

  const suggestions = useMemo(() => {
    if (
      !current ||
      !current.bpm ||
      !current.key
    ) {
      return [];
    }

    return knownTracks
      .filter((t) => t.bpm && t.key)
      .filter(
        (t) =>
          !(
            String(t.artist).toLowerCase() ===
              String(current.artist).toLowerCase() &&
            String(t.title).toLowerCase() ===
              String(current.title).toLowerCase()
          )
      )
      .map((t) => scoreTrack(current, t))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }, [current, knownTracks]);

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "Arial",
        maxWidth: 1100,
      }}
    >
      <h1>DJ Matcher V6.4 🎧</h1>

      <h2>Recherche Spotify</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          searchSpotify();
        }}
      >
        <input
          autoFocus
          placeholder="Daft Punk, Rihanna, Pitbull..."
          value={query}
          onChange={(e) =>
            setQuery(e.target.value)
          }
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
                      "hors base/API"}
                  </>
                )}
              </div>

              <button
                onClick={() =>
                  useTrack(track)
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

          {suggestions.length ===
            0 && (
            <p>
              Pas encore de
              suggestions.
            </p>
          )}

          {suggestions.map(
            (track, index) => (
              <div
                key={`${track.artist}-${track.title}-${index}`}
                style={{
                  border:
                    "1px solid #ddd",
                  padding: 10,
                  marginBottom: 8,
                  display: "flex",
                  gap: 12,
                  alignItems:
                    "center",
                }}
              >
                {track.image && (
                  <img
                    src={track.image}
                    width="100"
                    height="100"
                    alt=""
                    style={{
                      objectFit:
                        "cover",
                      borderRadius: 8,
                    }}
                  />
                )}

                <div
                  style={{
                    flex: 1,
                  }}
                >
                  <strong>
                    {track.title}
                  </strong>{" "}
                  — {track.artist}
                  <br />
                  Score DJ Matcher :{" "}
                  {track.score}
                  /100
                  <br />
                  BPM : {track.bpm} ·
                  Key : {track.key} ·
                  Camelot :{" "}
                  {track.camelot ||
                    "?"}{" "}
                  · Année :{" "}
                  {track.year || "?"}
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

                  {renderReasonTags(
                    track.reason
                  )}
                </div>

                <button
                  onClick={() =>
                    useTrack(track)
                  }
                >
                  Choisir
                </button>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}