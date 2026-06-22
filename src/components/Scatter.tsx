import type { ComponentChildren } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { labelColor, type XY } from '../color';

export type Pt = { x: number; y: number; fill: string; label: string; humanHex: string; catHex: string };

/** Closest pair by Euclidean distance in the plotted coordinates. */
export function closestPair(points: Pt[]): { i: number; j: number; d: number } | null {
  let best: { i: number; j: number; d: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (!best || d < best.d) best = { i, j, d };
    }
  }
  return best;
}

/** Plot geometry needed to walk a data-space grid: origin, side, scale and centre. */
type Geo = { ox: number; oy: number; plot: number; scale: number; cxD: number; cyD: number };

/**
 * Rasterise a per-pixel field to a data-URL once, then draw it as one <image> that
 * scales with the SVG. A modest internal resolution is plenty — the fields here are
 * smooth and the vector gamut hatch redraws the crisp edge on top. `paint` gets each
 * pixel's data-space (x, y) and writes its RGBA bytes at `o`; leaving them 0 yields a
 * transparent pixel. Returns null when no canvas context is available.
 */
function rasterField(geo: Geo, paint: (x: number, y: number, data: Uint8ClampedArray, o: number) => void): string | null {
  const RES = 200;
  const cv = document.createElement('canvas');
  cv.width = RES;
  cv.height = RES;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(RES, RES);
  const data = img.data;
  const { ox, oy, plot, scale, cxD, cyD } = geo;
  for (let j = 0; j < RES; j++) {
    const vy = oy + ((j + 0.5) / RES) * plot;
    const y = cyD - (vy - oy - plot / 2) / scale;
    for (let i = 0; i < RES; i++) {
      const vx = ox + ((i + 0.5) / RES) * plot;
      const x = cxD + (vx - ox - plot / 2) / scale;
      paint(x, y, data, (j * RES + i) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
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
  onPick,
  marker,
  measure,
  hint,
  shade,
  dim,
  onSelect,
  selected,
  onBackgroundClick,
  children,
}: {
  title: string;
  points: Pt[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  /** Closed polygon (in plot coords) bounding the human-visible region; the area
   *  inside the plot box but outside it is shaded as unreachable. */
  gamutBoundary?: XY[];
  /** Optional per-coordinate fill: maps a plot-space location to an [r,g,b] (0–255)
   *  color, or null where nothing should be drawn. Rendered as a raster layer behind
   *  the dots. Memoize it — a new identity re-renders the raster. */
  shade?: (loc: XY) => readonly [number, number, number] | null;
  /** Optional per-coordinate mask: true where the spot should be shaded out (e.g. its
   *  tinted color is below the legibility threshold). Rendered as a translucent wash
   *  over the shade layer, clipped to the gamut. Memoize it — a new identity re-renders
   *  the raster. */
  dim?: (loc: XY) => boolean;
  /** Small caption under the plot (e.g. to explain the shading). */
  note?: string;
  /** If set, clicking the plot reports the clicked data location plus the
   *  cursor's viewport position (so the caller can place a popup there). */
  onPick?: (loc: XY, screen: { x: number; y: number }) => void;
  /** Data-space location to draw a crosshair at (e.g. the last picked spot). */
  marker?: XY | null;
  /** Optional dotted line from `marker` to a target point (the nearest palette
   *  color). `belowMinSep` true → the gap is tighter than this plot's min
   *  separation, so the line is drawn red instead of the neutral ink color. */
  measure?: { to: XY; belowMinSep: boolean } | null;
  /** Small muted caption under the plot — e.g. a "click to inspect" hint. */
  hint?: string;
  /** If set, clicking (or keying Enter/Space on) a dot selects it by index. Takes
   *  precedence over `onPick` for dot clicks — the click stops there so picking an
   *  empty spot and selecting a dot stay distinct gestures. */
  onSelect?: (index: number) => void;
  /** Index of the currently-selected dot, drawn with a highlight ring. */
  selected?: number | null;
  /** Called on a click in empty plot space (one that isn't on a dot — dots
   *  stopPropagation) — e.g. to clear the selection. On the cat plot it fires
   *  alongside onPick (which also inspects that spot). */
  onBackgroundClick?: () => void;
  /** Extra content rendered in the card footer, below the min-separation stat
   *  (where note/hint would sit) — e.g. a plot-specific control. */
  children?: ComponentChildren;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [shadeUrl, setShadeUrl] = useState<string | null>(null);
  const [dimUrl, setDimUrl] = useState<string | null>(null);
  const clipId = useId();
  const hatchId = useId();
  const gamutClipId = useId();
  const dimMaskId = useId();
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

  // Raster the `shade` fill into a data-URL once per (geometry, shade) change. Bypasses
  // the discrete catMetamers path: here we want a continuous color per pixel.
  useEffect(() => {
    setShadeUrl(
      shade
        ? rasterField({ ox, oy, plot, scale, cxD, cyD }, (x, y, data, o) => {
            const rgb = shade({ x, y });
            if (rgb) {
              data[o] = rgb[0];
              data[o + 1] = rgb[1];
              data[o + 2] = rgb[2];
              data[o + 3] = 255;
            }
          })
        : null,
    );
  }, [shade, ox, oy, plot, scale, cxD, cyD]);

  // Raster the `dim` mask as opaque white where the spot is shaded out, transparent
  // elsewhere; an SVG <mask> then paints the themed wash through it. Re-renders when
  // the mask changes (it depends on the background and contrast threshold).
  useEffect(() => {
    setDimUrl(
      dim
        ? rasterField({ ox, oy, plot, scale, cxD, cyD }, (x, y, data, o) => {
            if (dim({ x, y })) {
              data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 255;
            }
          })
        : null,
    );
  }, [dim, ox, oy, plot, scale, cxD, cyD]);

  // Polygon tracing the in-gamut region (plot coords). Reused to clip the shade
  // layer to a crisp vector edge and to punch the out-of-gamut hatch.
  const hasGamut = !!(gamutBoundary && gamutBoundary.length > 2);
  const gamutPath = hasGamut
    ? gamutBoundary!.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`).join('') + 'Z'
    : '';

  // Dots are interactive when either gesture is wired: selecting a dot, or picking
  // an empty spot. Drives focusability and the AT role on the svg + dot targets.
  const interactive = !!(onSelect || onPick);
  const showVAxis = sx(0) >= ox && sx(0) <= ox + plot;
  const showHAxis = sy(0) >= oy && sy(0) <= oy + plot;
  const cp = closestPair(points);
  const fmt = (d: number) => (d < 1 ? d.toFixed(3) : d.toFixed(1));

  // Map a click to a data-space location, inverting sx/sy. getScreenCTM handles
  // CSS scaling and viewBox letterboxing, so the math stays in viewBox units.
  const handleClick = (e: MouseEvent) => {
    if (!onPick) return;
    const svg = e.currentTarget as SVGSVGElement;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const v = pt.matrixTransform(ctm.inverse());
    if (v.x < ox || v.x > ox + plot || v.y < oy || v.y > oy + plot) return; // outside the plot box
    const x = cxD + (v.x - ox - plot / 2) / scale;
    const y = cyD - (v.y - oy - plot / 2) / scale;
    onPick({ x, y }, { x: e.clientX, y: e.clientY });
  };

  // Keyboard path: each dot is focusable; Enter/Space picks at that dot, with the
  // popup anchored to the dot's on-screen centre. A 2-D plane has no good "spot"
  // for the keyboard, but the plotted colors are exactly the meaningful spots.
  const handleKeyPick = (e: KeyboardEvent, p: Pt) => {
    if (!onPick || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const r = (e.currentTarget as SVGGraphicsElement).getBoundingClientRect();
    onPick({ x: p.x, y: p.y }, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  };

  // A click reaches the svg only when it missed every dot (dots stopPropagation),
  // so it's a click on empty plot space: clear the selection, and — when pickable —
  // also inspect that spot (handleClick no-ops for clicks outside the plot box).
  const onSvgClick = (e: MouseEvent) => {
    onBackgroundClick?.();
    if (onPick) handleClick(e);
  };

  return (
    <div class="scatter">
      <div class="scatter-title">{title}</div>
      <svg
        viewBox={`0 0 ${S} ${S}`}
        class={`scatter-svg${onPick ? ' pickable' : ''}`}
        // A plain image when static; a labelled group when interactive, so the
        // focusable dot-buttons inside stay exposed to assistive tech (role="img"
        // would prune them).
        role={interactive ? 'group' : 'img'}
        aria-label={title}
        onClick={onPick || onBackgroundClick ? onSvgClick : undefined}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={ox} y={oy} width={plot} height={plot} rx="6" />
          </clipPath>
          {hasGamut && (
            // Diagonal hatch marking the unreachable region.
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
          )}
          {hasGamut && (
            // Clip the shade layer to the in-gamut polygon, so its edge is vector-
            // crisp and meets the hatch exactly instead of leaving a raster fringe.
            <clipPath id={gamutClipId}>
              <path d={gamutPath} />
            </clipPath>
          )}
          {dimUrl && (
            // White-where-shaded raster as a luminance mask, so the wash <rect> below
            // shows only over low-contrast spots and its color stays CSS-themeable.
            <mask id={dimMaskId} maskUnits="userSpaceOnUse" x={ox} y={oy} width={plot} height={plot}>
              <image href={dimUrl} x={ox} y={oy} width={plot} height={plot} preserveAspectRatio="none" />
            </mask>
          )}
        </defs>
        <rect x={ox} y={oy} width={plot} height={plot} class="scatter-bg" rx="6" />
        {shadeUrl && (
          <image
            href={shadeUrl}
            x={ox}
            y={oy}
            width={plot}
            height={plot}
            preserveAspectRatio="none"
            clip-path={`url(#${hasGamut ? gamutClipId : clipId})`}
          />
        )}
        {dimUrl && (
          <rect
            x={ox}
            y={oy}
            width={plot}
            height={plot}
            class="low-contrast"
            mask={`url(#${dimMaskId})`}
            clip-path={`url(#${hasGamut ? gamutClipId : clipId})`}
          />
        )}
        {hasGamut && (
          // Fill the plot box, then punch out the in-gamut polygon (even-odd), so
          // only cone-space coordinates no sRGB color can reach stay hatched.
          <path
            class="out-of-gamut"
            clip-path={`url(#${clipId})`}
            fill={`url(#${hatchId})`}
            fill-rule="evenodd"
            d={`M${ox} ${oy}H${ox + plot}V${oy + plot}H${ox}Z` + gamutPath}
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
            {selected === i && (
              // Highlight ring around the selected dot — shown in both plots.
              <circle cx={sx(p.x)} cy={sy(p.y)} r="9.5" class="dot-selected" />
            )}
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
            {/* larger transparent hit target so the small dots are easy to hover,
                and — when interactive — a keyboard-focusable button to select or
                inspect this dot */}
            <circle
              cx={sx(p.x)}
              cy={sy(p.y)}
              r="11"
              fill="transparent"
              class={interactive ? 'pick-target' : undefined}
              tabIndex={interactive ? 0 : undefined}
              role={interactive ? 'button' : undefined}
              aria-label={
                onSelect
                  ? `Select line ${p.label}`
                  : onPick
                  ? `Show the colors a cat sees at line ${p.label}`
                  : undefined
              }
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={interactive ? () => setHover(i) : undefined}
              onBlur={interactive ? () => setHover((h) => (h === i ? null : h)) : undefined}
              // A dot click selects and stops there, so it never also fires the
              // svg-level onPick (which would reopen a popover on the same gesture).
              onClick={
                onSelect
                  ? (e) => {
                      e.stopPropagation();
                      onSelect(i);
                    }
                  : undefined
              }
              onKeyDown={
                onSelect
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(i);
                      }
                    }
                  : onPick
                  ? (e) => handleKeyPick(e, p)
                  : undefined
              }
            />
          </g>
        ))}
        {marker && measure && (
          <line
            pointer-events="none"
            clip-path={`url(#${clipId})`}
            class={`measure-link ${measure.belowMinSep ? 'under' : 'over'}`}
            x1={sx(marker.x)}
            y1={sy(marker.y)}
            x2={sx(measure.to.x)}
            y2={sy(measure.to.y)}
          />
        )}
        {marker && (
          <g pointer-events="none" class="pick-marker" clip-path={`url(#${clipId})`}>
            <circle cx={sx(marker.x)} cy={sy(marker.y)} r="7.5" class="pick-ring" />
            <line x1={sx(marker.x) - 11} y1={sy(marker.y)} x2={sx(marker.x) + 11} y2={sy(marker.y)} class="pick-cross" />
            <line x1={sx(marker.x)} y1={sy(marker.y) - 11} x2={sx(marker.x)} y2={sy(marker.y) + 11} class="pick-cross" />
          </g>
        )}
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
          <span class="stat-label">min separation</span>
          <span class="stat-val">
            {fmt(cp.d)}
            {unit ? <span class="stat-unit"> {unit}</span> : null}
          </span>
          <span class="stat-lines">
            closest pair: lines {points[cp.i].label} &amp; {points[cp.j].label}
          </span>
        </div>
      )}
      {note && <div class="scatter-note">{note}</div>}
      {hint && <div class="scatter-hint">{hint}</div>}
      {children}
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
