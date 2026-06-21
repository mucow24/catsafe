import { useId, useState } from 'preact/hooks';
import { labelColor } from '../color';

export type Pt = { x: number; y: number; fill: string; label: string; humanHex: string; catHex: string };

/** Closest pair by Euclidean distance in the plotted coordinates. */
function closestPair(points: Pt[]): { i: number; j: number; d: number } | null {
  let best: { i: number; j: number; d: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (!best || d < best.d) best = { i, j, d };
    }
  }
  return best;
}

/**
 * Generic 2D scatter with EQUAL aspect (same pixels-per-unit on both axes), so
 * on-screen distance is faithful to the data. Draws a dotted link between the
 * two closest dots *in this plot's space* and reports that min separation below.
 */
export function Scatter({
  title,
  points,
  xLabel,
  yLabel,
  unit,
  gamutBoundary,
  note,
}: {
  title: string;
  points: Pt[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  /** Closed polygon (in plot coords) bounding the human-visible region; the area
   *  inside the plot box but outside it is shaded as unreachable. */
  gamutBoundary?: { x: number; y: number }[];
  /** Small caption under the plot (e.g. to explain the shading). */
  note?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const hatchId = useId();
  const S = 240;
  const M = { l: 24, r: 10, t: 10, b: 22 };
  const boxW = S - M.l - M.r;
  const boxH = S - M.t - M.b;
  const plot = Math.min(boxW, boxH);
  const ox = M.l + (boxW - plot) / 2;
  const oy = M.t + (boxH - plot) / 2;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) {
    minX = -1; maxX = 1; minY = -1; maxY = 1;
  }
  const cxD = (minX + maxX) / 2;
  const cyD = (minY + maxY) / 2;
  let half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.15;
  if (half < 1e-9) half = 1;
  const scale = plot / (2 * half);
  const sx = (x: number) => ox + plot / 2 + (x - cxD) * scale;
  const sy = (y: number) => oy + plot / 2 - (y - cyD) * scale;

  const showVAxis = sx(0) >= ox && sx(0) <= ox + plot;
  const showHAxis = sy(0) >= oy && sy(0) <= oy + plot;
  const cp = closestPair(points);
  const fmt = (d: number) => (d < 1 ? d.toFixed(3) : d.toFixed(1));

  return (
    <div class="scatter">
      <div class="scatter-title">{title}</div>
      <svg viewBox={`0 0 ${S} ${S}`} class="scatter-svg" role="img" aria-label={title}>
        {gamutBoundary && gamutBoundary.length > 2 && (
          <defs>
            <clipPath id={clipId}>
              <rect x={ox} y={oy} width={plot} height={plot} rx="6" />
            </clipPath>
            {/* Diagonal hatch marking the unreachable region. */}
            <pattern
              id={hatchId}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="7" height="7" class="oog-bg" />
              <line x1="0" y1="0" x2="0" y2="7" class="oog-line" />
            </pattern>
          </defs>
        )}
        <rect x={ox} y={oy} width={plot} height={plot} class="scatter-bg" rx="6" />
        {gamutBoundary && gamutBoundary.length > 2 && (
          // Fill the plot box, then punch out the in-gamut polygon (even-odd), so
          // only cone-space coordinates no sRGB color can reach stay hatched.
          <path
            class="out-of-gamut"
            clip-path={`url(#${clipId})`}
            fill={`url(#${hatchId})`}
            fill-rule="evenodd"
            d={
              `M${ox} ${oy}H${ox + plot}V${oy + plot}H${ox}Z` +
              gamutBoundary
                .map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`)
                .join('') +
              'Z'
            }
          />
        )}
        {showVAxis && <line x1={sx(0)} y1={oy} x2={sx(0)} y2={oy + plot} class="axis" />}
        {showHAxis && <line x1={ox} y1={sy(0)} x2={ox + plot} y2={sy(0)} class="axis" />}
        {cp && (
          <line
            x1={sx(points[cp.i].x)}
            y1={sy(points[cp.i].y)}
            x2={sx(points[cp.j].x)}
            y2={sy(points[cp.j].y)}
            class="closest-link"
          />
        )}
        {points.map((p, i) => (
          <g key={p.label}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r="6" fill={p.fill} stroke="#0007" stroke-width="1" />
            <text
              x={sx(p.x)}
              y={sy(p.y)}
              class="pt-label"
              fill={labelColor(p.fill)}
              text-anchor="middle"
              dominant-baseline="central"
            >
              {p.label}
            </text>
            {/* larger transparent hit target so the small dots are easy to hover */}
            <circle
              cx={sx(p.x)}
              cy={sy(p.y)}
              r="11"
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            />
          </g>
        ))}
        {hover != null && points[hover] && (
          <Tip p={points[hover]} x={sx(points[hover].x)} y={sy(points[hover].y)} bounds={S} />
        )}
        {xLabel && (
          <text x={ox + plot / 2} y={S - 5} class="axis-label" text-anchor="middle">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text
            x={9}
            y={oy + plot / 2}
            class="axis-label"
            text-anchor="middle"
            transform={`rotate(-90 9 ${oy + plot / 2})`}
          >
            {yLabel}
          </text>
        )}
      </svg>
      {cp && (
        <div class="scatter-stat">
          min sep <strong>{fmt(cp.d)}{unit ? ` ${unit}` : ''}</strong> · lines {points[cp.i].label} &amp;{' '}
          {points[cp.j].label}
        </div>
      )}
      {note && <div class="scatter-note">{note}</div>}
    </div>
  );
}

function Tip({ p, x, y, bounds }: { p: Pt; x: number; y: number; bounds: number }) {
  const tw = 116;
  const th = 56;
  const pad = 7;
  const sw = 11;
  const keyX = pad + sw + 6;
  const hexX = keyX + 34;
  let tx = x + 9;
  let ty = y - th - 4;
  if (tx + tw > bounds) tx = x - tw - 9;
  if (tx < 2) tx = 2;
  if (ty < 2) ty = y + 9;
  // Both fields are shown for every dot, so hovering either plot tells you the
  // human color and its simulated cat counterpart at once.
  const rows = [
    { key: 'human', hex: p.humanHex },
    { key: 'cat', hex: p.catHex },
  ];
  return (
    <g pointer-events="none">
      <rect x={tx} y={ty} width={tw} height={th} rx="5" class="tip-bg" />
      <text x={tx + pad} y={ty + pad + 8} class="tip-head">
        line {p.label}
      </text>
      {rows.map((r, i) => {
        const cy = ty + pad + 24 + i * 16;
        return (
          <g key={r.key}>
            <rect x={tx + pad} y={cy - sw / 2} width={sw} height={sw} rx="2" fill={r.hex} stroke="#0007" />
            <text x={tx + keyX} y={cy} class="tip-key" dominant-baseline="central">
              {r.key}
            </text>
            <text x={tx + hexX} y={cy} class="tip-text" dominant-baseline="central">
              {r.hex}
            </text>
          </g>
        );
      })}
    </g>
  );
}
