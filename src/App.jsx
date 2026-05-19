import { useEffect, useState } from "react";
import "./App.css";

const API =
  import.meta.env.VITE_API_URL || "http://localhost:3001";

function App() {
  const [query, setQuery] = useState("");
  const [spotifyResults, setSpotifyResults] = useState([]);
  const [knownTracks, setKnownTracks] = useState([]);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [status, setStatus] = useState("");

  async function loadKnownTracks() {
    try {
      const res = await fetch(`${API}/api/known-tracks`);
      const data = await res.json();
      setKnownTracks(data);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    loadKnownTracks();
  }, []);

  function normalize(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  async function enrichTrack(track) {
    try {
      const title = track.name;
      const artist = track.artists?.[0]?.name || "";

      const localMatch = knownTracks.find(
        (t) =>
          normalize(t.title) === normalize(title) &&
          normalize(t.artist).includes(normalize(artist))
      );

      if (localMatch) {
        return {
          ...track,
          bpm: localMatch.bpm,
          key: localMatch.key,
          enriched: true,
          source: localMatch.source,
        };
      }

      return track;
    } catch (err) {
      console.error(err);
      return track;
    }
  }

  async function searchSpotify() {
    if (!query.trim()) return;

    setStatus("Recherche...");
    setSpotifyResults([]);

    try {
      // Recherche locale
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
            ? [
                { url: track.image },
                { url: track.image },
                { url: track.image },
              ]
            : [],
        },
        bpm: track.bpm,
        key: track.key,
        source: track.source || "local",
        enriched: true,
        isLocal: true,
      }));

      // Recherche Spotify
      const spotifyRes = await fetch(
        `${API}/api/search?q=${encodeURIComponent(query)}`
      );

      const spotifyData = await spotifyRes.json();
      const spotifyItems = spotifyData.tracks?.items || [];

      // Suppression doublons
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
      setStatus(`${mergedItems.length} résultat(s)`);
    } catch (error) {
      console.error(error);
      setStatus("Erreur pendant la recherche.");
    }
  }

  function computeCompatibility(a, b) {
    let score = 0;
    const reasons = [];

    if (a.bpm && b.bpm) {
      const diff = Math.abs(a.bpm - b.bpm);

      if (diff === 0) {
        score += 40;
        reasons.push("🟢 BPM parfait");
      } else if (diff <= 2) {
        score += 30;
        reasons.push("BPM proche");
      } else if (diff <= 5) {
        score += 15;
        reasons.push("BPM compatible");
      }
    }

    if (a.key && b.key) {
      if (a.key === b.key) {
        score += 40;
        reasons.push("🟢 Même tonalité");
      }
    }

    return {
      score,
      reasons,
    };
  }

  function generateSuggestions(track) {
    const compatible = knownTracks
      .filter(
        (t) =>
          t.title !== track.name &&
          t.bpm &&
          t.key
      )
      .map((t) => ({
        ...t,
        compatibility: computeCompatibility(
          {
            bpm: track.bpm,
            key: track.key,
          },
          t
        ),
      }))
      .sort((a, b) => b.compatibility.score - a.compatibility.score)
      .slice(0, 12);

    setSuggestions(compatible);
  }

  function chooseTrack(track) {
    setSelectedTrack(track);
    generateSuggestions(track);
  }

  return (
    <div className="app">
      <h1>DJ Matcher</h1>
      <p>Recherche Spotify</p>

      <div className="search-bar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Titre ou artiste..."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              searchSpotify();
            }
          }}
        />

        <button onClick={searchSpotify}>
          Rechercher
        </button>
      </div>

      <p>{status}</p>

      {selectedTrack && (
        <div className="selected-track">
          <h2>Morceau sélectionné</h2>

          <div className="track-card active">
            <img
              src={
                selectedTrack.album?.images?.[0]?.url ||
                "https://placehold.co/100x100"
              }
              width="100"
              height="100"
            />

            <div>
              <h3>{selectedTrack.name}</h3>

              <p>
                {selectedTrack.artists?.map((a) => a.name).join(", ")}
              </p>

              <div className="tags centered">
                <span>{selectedTrack.bpm || "?"} BPM</span>
                <span>{selectedTrack.key || "?"}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="results">
        {spotifyResults.map((track) => (
          <div key={track.id} className="track-card">
            <img
              src={
                track.album?.images?.[0]?.url ||
                "https://placehold.co/100x100"
              }
              width="100"
              height="100"
            />

            <div className="track-info">
              <h3>{track.name}</h3>

              <p>
                {track.artists?.map((a) => a.name).join(", ")}
              </p>

              <div className="tags centered">
                <span>{track.bpm || "?"} BPM</span>
                <span>{track.key || "?"}</span>
              </div>

              <button
                className="choose-btn"
                onClick={() => chooseTrack(track)}
              >
                Choisir
              </button>
            </div>
          </div>
        ))}
      </div>

      {suggestions.length > 0 && (
        <div className="suggestions">
          <h2>Suggestions</h2>

          {suggestions.map((s, index) => (
            <div key={index} className="track-card suggestion">
              <img
                src={
                  s.image || "https://placehold.co/100x100"
                }
                width="100"
                height="100"
              />

              <div className="track-info">
                <h3>{s.title}</h3>

                <p>{s.artist}</p>

                <div className="tags centered">
                  <span>{s.bpm} BPM</span>
                  <span>{s.key}</span>
                </div>

                <p
                  style={{
                    fontWeight: "bold",
                    marginTop: "8px",
                  }}
                >
                  {s.compatibility.reasons.join(" · ")}
                </p>

                <button
                  className="choose-btn"
                  onClick={() =>
                    chooseTrack({
                      name: s.title,
                      artists: [{ name: s.artist }],
                      bpm: s.bpm,
                      key: s.key,
                      album: {
                        images: s.image
                          ? [{ url: s.image }]
                          : [],
                      },
                    })
                  }
                >
                  Choisir
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;