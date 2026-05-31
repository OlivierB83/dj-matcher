import { useRef } from "react";
import {
  Archive,
  Search,
  Filter,
  Disc3,
  ArrowLeft,
  Heart,
} from "lucide-react";

/**
 * Two overlapping vinyl discs (Claude design). The right disc sits on top of
 * the left one — the visual cue for "matching two tracks".
 */
function DiscPair({ size = 40 }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="DJ Matcher logo"
    >
      <defs>
        <linearGradient id="dm-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7f77dd" />
          <stop offset="100%" stopColor="#534ab7" />
        </linearGradient>
        <radialGradient id="dm-disc" cx="0.5" cy="0.45" r="0.55">
          <stop offset="0%" stopColor="#2c2748" />
          <stop offset="100%" stopColor="#0e0814" />
        </radialGradient>
        <radialGradient id="dm-label" cx="0.5" cy="0.45" r="0.5">
          <stop offset="0%" stopColor="#c0b3ff" />
          <stop offset="100%" stopColor="#7f77dd" />
        </radialGradient>
      </defs>

      <rect width="100" height="100" rx="22" fill="url(#dm-bg)" />

      {/* Left disc */}
      <g>
        <circle cx="40" cy="52" r="26" fill="url(#dm-disc)" stroke="#0e0814" strokeWidth="0.5" />
        <circle cx="40" cy="52" r="22" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.18" />
        <circle cx="40" cy="52" r="17" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.12" />
        <circle cx="40" cy="52" r="12" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.18" />
        <circle cx="40" cy="52" r="8" fill="url(#dm-label)" />
        <circle cx="40" cy="52" r="1.7" fill="#160e1e" />
      </g>

      {/* Right disc (on top) */}
      <g>
        <circle cx="60" cy="52" r="26" fill="url(#dm-disc)" stroke="#0e0814" strokeWidth="0.5" />
        <circle cx="60" cy="52" r="22" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.18" />
        <circle cx="60" cy="52" r="17" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.12" />
        <circle cx="60" cy="52" r="12" fill="none" stroke="#ffffff" strokeWidth="0.5" opacity="0.18" />
        <circle cx="60" cy="52" r="8" fill="url(#dm-label)" />
        <circle cx="60" cy="52" r="1.7" fill="#160e1e" />
      </g>
    </svg>
  );
}

export function Header({
  forgottenCount = 0,
  onOpenForgotten,
  onBack,
  isForgottenView = false,
  backCount = 0,
}) {
  return (
    <header className="header">
      <div className="header-brand">
        <div className="header-logo">
          <DiscPair size="100%" />
        </div>
        <div>
          <div className="header-title">DJ Matcher</div>
          <div className="header-version">v7.5</div>
        </div>
      </div>

      <div className="header-actions">
        {isForgottenView ? (
          <button className="header-action" onClick={onBack}>
            <ArrowLeft size={14} />
            Retour
          </button>
        ) : (
          <>
            {backCount > 0 && (
              <button
                className="header-action"
                onClick={onBack}
                title="Revenir aux suggestions précédentes ou annuler un oubli"
              >
                <ArrowLeft size={14} />
                Retour{" "}
                <span className="header-action-count">{backCount}</span>
              </button>
            )}

            <button className="header-action" onClick={onOpenForgotten}>
              <Archive size={14} />
              Oubliés{" "}
              <span className="header-action-count">{forgottenCount}</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  autocomplete = null,
}) {
  const blurTimer = useRef(null);

  return (
    <section className="search-section">
      <label className="search-label">Recherche Spotify</label>
      <div className="search-row">
        <div className="search-input-wrap">
          <Search size={16} className="search-input-icon" />
          <input
            className="search-input"
            type="text"
            placeholder="Daft Punk, Rihanna, Pitbull…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            onFocus={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current);
              autocomplete?.onFocus?.();
            }}
            onBlur={() => {
              blurTimer.current = setTimeout(
                () => autocomplete?.onBlur?.(),
                150
              );
            }}
          />

          {autocomplete?.open && autocomplete.items.length > 0 && (
            <ul className="autocomplete-list">
              {autocomplete.items.map((item, i) => (
                <li
                  key={item.key || i}
                  className="autocomplete-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    autocomplete.onSelect(item);
                  }}
                >
                  <strong>{item.title}</strong>{" "}
                  <span className="autocomplete-artist">— {item.artist}</span>
                  {item.bpm && item.camelot && (
                    <span className="autocomplete-meta">
                      {" "}
                      · {item.bpm} BPM · {item.camelot}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="search-button" onClick={onSubmit}>
          Rechercher
        </button>
      </div>
    </section>
  );
}

export function CurrentTrack({ track, isFavorite = false, onToggleFavorite }) {
  if (!track) return null;
  return (
    <div className="current-track">
      <div className="current-cover">
        {track.coverUrl ? (
          <img src={track.coverUrl} alt="" />
        ) : (
          <Disc3 size={32} color="var(--brand)" />
        )}
      </div>
      <div className="current-info">
        <div className="current-label">Morceau courant</div>
        <div className="current-title">
          {track.title}{" "}
          <span className="current-artist">— {track.artist}</span>
        </div>
        <div className="meta-row">
          <span>
            <span className="meta-label">BPM</span>
            {track.bpm ?? "—"}
          </span>
          <span>
            <span className="meta-label">KEY</span>
            {track.key ?? "—"}
          </span>
          <span>
            <span className="meta-label">CAMELOT</span>
            <span className="meta-camelot-perfect">{track.camelot ?? "—"}</span>
          </span>
          <span>
            <span className="meta-label">YEAR</span>
            {track.year ?? "—"}
          </span>
        </div>
      </div>
      {onToggleFavorite && (
        <button
          className={`btn-fav${isFavorite ? " is-fav" : ""}`}
          onClick={onToggleFavorite}
          aria-label={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
        >
          <Heart size={16} fill={isFavorite ? "currentColor" : "none"} />
        </button>
      )}
    </div>
  );
}

export function SuggestionsHeader({ count, onFilter, filterLabel }) {
  return (
    <div className="suggestions-header">
      <div className="suggestions-title">
        <h3>Suggestions</h3>
        <span className="suggestions-count">{count} résultats</span>
      </div>
      <button className="suggestions-filter" onClick={onFilter}>
        <Filter size={12} />
        {filterLabel || "Filtrer par style"}
      </button>
    </div>
  );
}
