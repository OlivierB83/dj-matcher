import { motion } from "framer-motion";
import { Heart } from "lucide-react";
import { CompatBadge, FavBadge } from "./Badges";

function scoreColorClass(score) {
  if (score >= 85) return "score-high";
  if (score >= 70) return "score-mid";
  return "score-low";
}

function camelotClass(level) {
  if (level === "perfect") return "meta-camelot-perfect";
  if (level === "close") return "meta-camelot-close";
  return "";
}

const bpmLabel = (l) =>
  ({ perfect: "BPM parfait", close: "BPM proche", far: "BPM éloigné" })[l];
const keyLabel = (l) =>
  ({
    perfect: "tonalité parfaite",
    close: "tonalité proche",
    far: "tonalité éloignée",
  })[l];
const styleLabel = (l) =>
  ({ perfect: "style parfait", close: "style proche", far: "style éloigné" })[l];
const danceLabel = (l) =>
  ({ perfect: "dance parfait", close: "dance proche", far: "dance éloigné" })[l];

export function TrackCard({
  track,
  compat,
  featured = false,
  isFavorite = false,
  onChoose,
  onToggleFavorite,
  onForget,
}) {
  return (
    <motion.div
      className={`track-card is-clickable${featured ? " featured" : ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      layout
      onClick={onChoose}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose?.();
        }
      }}
    >
      <div className="track-main">
        <div className="track-cover">
          {track.coverUrl ? (
            <img src={track.coverUrl} alt="" />
          ) : (
            <span aria-hidden>🎵</span>
          )}
        </div>

        <div className="track-info">
          <div className="track-title">
            {track.title}
            {isFavorite && (
              <Heart
                size={14}
                fill="currentColor"
                color="var(--fav-fg)"
                style={{ marginLeft: 6, verticalAlign: "-2px" }}
              />
            )}
          </div>
          <div className="track-artist">{track.artist}</div>

          <div className="meta-row">
            <span>
              <span className="meta-label">BPM</span>
              {track.bpm ?? "—"}
            </span>
            <span>
              <span className="meta-label">KEY</span>
              {track.key ?? "—"}
            </span>
            <span className={camelotClass(compat.camelot)}>
              {track.camelot ?? "—"}
            </span>
            <span>
              <span className="meta-label">YEAR</span>
              {track.year ?? "—"}
            </span>
            <span>
              <span className="meta-label">DANCE</span>
              {track.dance != null ? `${track.dance}%` : "—"}
            </span>
          </div>

          <div className="badges">
            {isFavorite && <FavBadge />}
            <CompatBadge level={compat.bpm} label={bpmLabel(compat.bpm)} />
            <CompatBadge level={compat.key} label={keyLabel(compat.key)} />
            <CompatBadge level={compat.style} label={styleLabel(compat.style)} />
            <CompatBadge level={compat.dance} label={danceLabel(compat.dance)} />
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

      <div className="track-footer">
        <motion.div
          className="score"
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
          <span className={`score-num ${scoreColorClass(track.score)}`}>
            {track.score}
          </span>
          <span className="score-label">score</span>
        </motion.div>

        <button
          className="btn-forget"
          onClick={(e) => {
            e.stopPropagation();
            onForget?.();
          }}
        >
          oublier ce titre
        </button>
      </div>
    </motion.div>
  );
}
