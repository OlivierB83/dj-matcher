/**
 * Pochette de secours : tuile générée à partir de la clé Camelot et du BPM,
 * affichée quand un titre n'a pas de pochette (ni iTunes, ni Deezer).
 * Aucune image externe : la teinte vient de la position sur la roue
 * Camelot (12 teintes), les mineures (A) sont plus sombres que les
 * majeures (B). Le SVG en viewBox s'adapte à toutes les tailles de cadre
 * (28 px dans les listes, 110 px pour le morceau courant, héros 16:9 mobile).
 */

function camelotHue(camelot) {
  const m = /^(\d{1,2})\s*([AB])$/i.exec(String(camelot || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, minor: m[2].toUpperCase() === "A", hue: ((n - 1) * 30 + 120) % 360 };
}

function camelotGradient(camelot) {
  const c = camelotHue(camelot);
  if (!c) return "linear-gradient(135deg, #3a3a4a, #1c1c26)";
  const l1 = c.minor ? 30 : 42;
  const l2 = c.minor ? 16 : 26;
  return `linear-gradient(135deg, hsl(${c.hue} 55% ${l1}%), hsl(${(c.hue + 40) % 360} 60% ${l2}%))`;
}

export function CamelotTile({ camelot, bpm, className = "" }) {
  const c = camelotHue(camelot);
  const label = c ? `${c.n}${c.minor ? "A" : "B"}` : "♪";
  return (
    <div className={`camelot-tile ${className}`} style={{ background: camelotGradient(camelot) }} aria-hidden>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        <text x="50" y={bpm ? 52 : 60} textAnchor="middle" fontSize={c ? 36 : 40} fontWeight="800" fill="#fff">
          {label}
        </text>
        {bpm ? (
          <text x="50" y="74" textAnchor="middle" fontSize="13" fontWeight="600" fill="rgba(255,255,255,0.78)">
            {bpm} BPM
          </text>
        ) : null}
      </svg>
    </div>
  );
}
