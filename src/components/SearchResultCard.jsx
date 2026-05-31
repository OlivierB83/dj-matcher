import { motion } from "framer-motion";
import { Heart } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

function formatGenres(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return null;
  return genres.slice(0, 4).join(" · ");
}

function Cover({ track, className }) {
  return (
    <div className={className}>
      {track.coverUrl ? (
        <img src={track.coverUrl} alt="" />
      ) : (
        <span aria-hidden>🎵</span>
      )}
    </div>
  );
}

/* ===== Mobile layout — hero cover (mirrors TrackCard mobile pattern) ===== */
function SearchResultCardMobile({
  track,
  isFavorite,
  onChoose,
  onToggleFavorite,
}) {
  const enriched = track.enriched;
  const style = formatGenres(track.genres);
  const handleKeyDown = (e) => {
    if (!enriched) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChoose?.();
    }
  };
  return (
    <motion.div
      className={`tcard-m${enriched ? " is-clickable" : ""}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      layout
      onClick={enriched ? onChoose : undefined}
      role={enriched ? "button" : undefined}
      tabIndex={enriched ? 0 : undefined}
      onKeyDown={handleKeyDown}
      style={!enriched ? { opacity: 0.6 } : undefined}
    >
      <div className="tcard-m-top">
        <Cover track={track} className="tcard-m-cover-img" />

        <div className="tcard-m-overlay">
          {track.coverUrl && (
            <div
              className="tcard-m-halo"
              style={{ backgroundImage: `url(${track.coverUrl})` }}
              aria-hidden
            />
          )}

          {enriched && (
            <button
              className={`tcard-m-fav${isFavorite ? " is-fav" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite?.();
              }}
              aria-label={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
              style={{ marginLeft: "auto" }}
            >
              <Heart size={22} fill={isFavorite ? "currentColor" : "none"} />
            </button>
          )}
        </div>
      </div>

      <div className="tcard-m-body">
        <div className="tcard-m-title">{track.title}</div>
        <div className="tcard-m-artist">{track.artist}</div>

        {enriched ? (
          <>
            <div className="meta-row">
              <span><span className="meta-label">BPM</span>{track.bpm}</span>
              <span><span className="meta-label">KEY</span>{track.key}</span>
              <span className="meta-camelot-perfect">{track.camelot || "?"}</span>
              {track.year && (
                <span><span className="meta-label">YEAR</span>{track.year}</span>
              )}
            </div>
            {style && <div className="srcard-style">{style}</div>}
          </>
        ) : (
          <div className="srcard-not-enriched">
            Non enrichi · {track.enrichMessage || "hors catalogue"}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ===== Desktop layout — compact horizontal row ===== */
function SearchResultCardDesktop({
  track,
  isFavorite,
  onChoose,
  onToggleFavorite,
}) {
  const enriched = track.enriched;
  const style = formatGenres(track.genres);
  const handleKeyDown = (e) => {
    if (!enriched) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChoose?.();
    }
  };
  return (
    <motion.div
      className={`track-card${enriched ? " is-clickable" : ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      layout
      onClick={enriched ? onChoose : undefined}
      role={enriched ? "button" : undefined}
      tabIndex={enriched ? 0 : undefined}
      onKeyDown={handleKeyDown}
      style={!enriched ? { opacity: 0.6 } : undefined}
    >
      <div className="track-row">
        <Cover track={track} className="track-cover" />

        <div className="track-info">
          <div className="track-title">{track.title}</div>
          <div className="track-artist">
            {track.artist}
            {track.album ? ` · ${track.album}` : ""}
          </div>

          {enriched ? (
            <>
              <div className="meta-row">
                <span><span className="meta-label">BPM</span>{track.bpm}</span>
                <span><span className="meta-label">KEY</span>{track.key}</span>
                <span className="meta-camelot-perfect">{track.camelot || "?"}</span>
                {track.year && (
                  <span><span className="meta-label">YEAR</span>{track.year}</span>
                )}
              </div>
              {style && <div className="srcard-style">{style}</div>}
            </>
          ) : (
            <div className="srcard-not-enriched">
              Non enrichi · {track.enrichMessage || "hors catalogue"}
            </div>
          )}
        </div>

        {enriched && (
          <div className="track-score-col">
            <button
              className={`btn-fav${isFavorite ? " is-fav" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite?.();
              }}
              aria-label={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
              style={{ alignSelf: "center" }}
            >
              <Heart size={18} fill={isFavorite ? "currentColor" : "none"} />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function SearchResultCard(props) {
  const isMobile = useIsMobile(600);
  return isMobile ? (
    <SearchResultCardMobile {...props} />
  ) : (
    <SearchResultCardDesktop {...props} />
  );
}
