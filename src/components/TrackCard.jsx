import { motion } from "framer-motion";
import { Heart } from "lucide-react";
import { CompatBadge } from "./Badges";
import { useIsMobile } from "../hooks/useIsMobile";

/* ===== Shared helpers ===== */

/** Score color band: 85+ vivid green · 70-84 pale green · <70 amber */
function scoreColorClass(score) {
  if (score >= 85) return "score-high";
  if (score >= 70) return "score-mid";
  return "score-low";
}

/** Camelot color follows the same compatibility logic as the badges. */
function camelotClass(level) {
  if (level === "perfect") return "meta-camelot-perfect";
  if (level === "close") return "meta-camelot-close";
  return "";
}

const bpmLabel   = (l) => ({ perfect: "BPM parfait",       close: "BPM proche",       far: "BPM éloigné" })[l];
const keyLabel   = (l) => ({ perfect: "tonalité parfaite", close: "tonalité proche",  far: "tonalité éloignée" })[l];
const styleLabel = (l) => ({ perfect: "style parfait",     close: "style proche",     far: "style éloigné" })[l];
const danceLabel = (l) => ({ perfect: "dance parfait",     close: "dance proche",     far: "dance éloigné" })[l];

/** Meta line (BPM / KEY / Camelot / Year / Dance), shared by both layouts. */
function MetaRow({ track, compat }) {
  return (
    <div className="meta-row">
      <span><span className="meta-label">BPM</span>{track.bpm ?? "—"}</span>
      <span><span className="meta-label">KEY</span>{track.key ?? "—"}</span>
      <span className={camelotClass(compat.camelot)}>{track.camelot ?? "—"}</span>
      {track.year != null && (
        <span><span className="meta-label">YEAR</span>{track.year}</span>
      )}
      {track.dance != null && (
        <span><span className="meta-label">DANCE</span>{track.dance}%</span>
      )}
    </div>
  );
}

/**
 * Compatibility badges + the "oublier ce titre" action.
 * The forget button shares the same flex row via margin-left:auto, so it
 * sits at the right of the last badge line (or wraps to its own line on the
 * right if there's no room).
 */
function BadgeRow({ compat, onForget }) {
  return (
    <div className="badges">
      <CompatBadge level={compat.bpm}   label={bpmLabel(compat.bpm)} />
      <CompatBadge level={compat.key}   label={keyLabel(compat.key)} />
      <CompatBadge level={compat.dance} label={danceLabel(compat.dance)} />
      <CompatBadge level={compat.style} label={styleLabel(compat.style)} />
      {onForget && (
        <button
          className="btn-forget"
          onClick={(e) => {
            e.stopPropagation();
            onForget();
          }}
        >
          oublier ce titre
        </button>
      )}
    </div>
  );
}

/** Cover image with emoji/disc fallback. */
function Cover({ track, className }) {
  return (
    <div className={className}>
      {track.coverUrl ? <img src={track.coverUrl} alt="" /> : <span aria-hidden>🎵</span>}
    </div>
  );
}

/* ===== Mobile layout — hero cover, score overlay ===== */

function TrackCardMobile({ track, compat, featured, isFavorite, onChoose, onToggleFavorite, onForget }) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChoose?.();
    }
  };
  return (
    <motion.div
      className={`tcard-m is-clickable${featured ? " featured" : ""}`}
      data-track-key={track.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      layout
      onClick={onChoose}
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="tcard-m-top">
        <div className="tcard-m-cover-img">
          {track.coverUrl ? (
            <img src={track.coverUrl} alt="" />
          ) : (
            <span aria-hidden>🎵</span>
          )}
        </div>

        <div className="tcard-m-overlay">
          {track.coverUrl && (
            <div
              className="tcard-m-halo"
              style={{ backgroundImage: `url(${track.coverUrl})` }}
              aria-hidden
            />
          )}

          <div className="tcard-m-score">
            <div className={`tcard-m-score-num ${scoreColorClass(track.score)}`}>{track.score}</div>
            <div className="tcard-m-score-label">score</div>
          </div>

          <button
            className={`tcard-m-fav${isFavorite ? " is-fav" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.();
            }}
            aria-label={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
          >
            <Heart size={22} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </div>

      <div className="tcard-m-body">
        <div className="tcard-m-title">{track.title}</div>
        <div className="tcard-m-artist">{track.artist}</div>
        <MetaRow track={track} compat={compat} />

        <div className="badges">
          <CompatBadge level={compat.bpm} label={bpmLabel(compat.bpm)} />
          <CompatBadge level={compat.key} label={keyLabel(compat.key)} />
          <CompatBadge
            level={compat.dance}
            label={danceLabel(compat.dance)}
            className="badges-push-right"
          />
        </div>
        <div className="badges">
          <CompatBadge level={compat.style} label={styleLabel(compat.style)} />
          <button
            className="btn-forget badges-push-right"
            onClick={(e) => {
              e.stopPropagation();
              onForget?.();
            }}
          >
            oublier ce titre
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/* ===== Desktop layout — compact horizontal row ===== */

function TrackCardDesktop({ track, compat, featured, isFavorite, onChoose, onToggleFavorite, onForget }) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChoose?.();
    }
  };
  return (
    <motion.div
      className={`track-card is-clickable${featured ? " featured" : ""}`}
      data-track-key={track.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      layout
      onClick={onChoose}
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="track-row">
        <Cover track={track} className="track-cover" />

        <div className="track-info">
          <div className="track-title">
            {track.title}
            {isFavorite && (
              <Heart size={16} fill="currentColor" color="var(--fav-fg)"
                     style={{ marginLeft: 6, verticalAlign: "-2px" }} />
            )}
          </div>
          <div className="track-artist">{track.artist}</div>
          <MetaRow track={track} compat={compat} />
          <BadgeRow compat={compat} />
        </div>

        <div className="track-score-col">
          <div className="track-score-top">
            <button
              className="btn-forget"
              onClick={(e) => {
                e.stopPropagation();
                onForget?.();
              }}
            >
              oublier ce titre
            </button>
            <div className="score">
              <div className={`score-num ${scoreColorClass(track.score)}`}>{track.score}</div>
              <div className="score-label">score</div>
            </div>
          </div>
          <button
            className={`btn-fav${isFavorite ? " is-fav" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.();
            }}
            aria-label={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
          >
            <Heart size={18} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/* ===== Public component — picks the layout ===== */

export function TrackCard(props) {
  const isMobile = useIsMobile(600);
  return isMobile ? <TrackCardMobile {...props} /> : <TrackCardDesktop {...props} />;
}
