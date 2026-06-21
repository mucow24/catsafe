import { rgb, oklab, oklch, formatHex, wcagLuminance, clampChroma } from 'culori';

export type Lab = { l: number; a: number; b: number };
export type XY = { x: number; y: number };
/** A color in both perceptual fields: human OKLab, and the cat 2D RNL cone space. */
export type Sim = { human: Lab; catXY: XY };
/** One member of a cat-metamer set: a human sRGB hex and its illustrative cat rendering. */
export type Metamer = { hex: string; cat: string };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

// =====================================================================
// Cat vision — receptor-noise-limited (RNL) cone model.
// The scatter plot axes and the distance metric are the SAME 2D space, so
// "looks close" == "is close" by construction.
// =====================================================================
// No validated cat colorimetric model exists. We approximate the cat's two
// cones with the human S (cat ~450 nm) and human L (cat ~556 nm) fundamentals,
// dropping M (human L is ~3–10 nm from cat-L, vs ~26 nm for M). Then a
// Vorobyev–Osorio RNL space:
//   x = blue↔yellow opponent (f_S − f_L), JND-scaled, noise-weighted
//   y = luminance (L-cone log catch), JND-scaled  ← the cat's dominant channel
// Euclidean distance in (x, y) equals the RNL ΔS.

// linear sRGB -> human LMS (Stockman–Sharpe 2-deg), pre-composed & verified.
// Rows: L, M, S. (M is kept for clarity but never used for the cat.)
const RGB_TO_LMS = [
  [0.26789925, 0.68210584, 0.06200190],
  [0.07985312, 0.70217236, 0.08445362],
  [0.00999084, 0.06160404, 0.49126830],
] as const;
// Cone catches for linear-sRGB white (1,1,1) — von Kries normalization targets.
const WHITE_L = 1.012007;
const WHITE_S = 0.562863;

// RNL constants
const OMEGA = 0.05; // Weber fraction (most abundant cone)
const ETA_L = 0.85; // cat L-cone relative abundance
const ETA_S = 0.15; // cat S-cone relative abundance (~10–20%)
const E_L = OMEGA / Math.sqrt(ETA_L); // ≈ 0.05423
const E_S = OMEGA / Math.sqrt(ETA_S); // ≈ 0.12910  (S ≈ 2.4× noisier than L)
const E_LUM = E_L; // luminance rides the abundant L cone
const CHROMA_SCALE = Math.hypot(E_S, E_L); // ≈ 0.14003
const EPS = 1e-6;

/** Cat cone catches [qS, qL], von-Kries normalized so white -> 1. */
function catCones(hex: string): { qS: number; qL: number } {
  const c = rgb(hex);
  if (!c) return { qS: 1, qL: 1 };
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const L = RGB_TO_LMS[0][0] * r + RGB_TO_LMS[0][1] * g + RGB_TO_LMS[0][2] * b;
  const S = RGB_TO_LMS[2][0] * r + RGB_TO_LMS[2][1] * g + RGB_TO_LMS[2][2] * b;
  return { qS: S / WHITE_S, qL: L / WHITE_L };
}

/** Cat 2D RNL coordinates (JND units): x = yellow↔blue, y = dark↔light. */
export function catSpace(hex: string): XY {
  const { qS, qL } = catCones(hex);
  const fS = Math.log(qS + EPS);
  const fL = Math.log(qL + EPS);
  return { x: (fS - fL) / CHROMA_SCALE, y: fL / E_LUM };
}

// ---------------------------------------------------------------------
// Cat SWATCH rendering — Machado-2009 deuteranope sim + chroma cut.
// Display only: this is a "roughly what the cat sees" picture and is
// deliberately decoupled from the plot/metric (which use the RNL space above).
// ---------------------------------------------------------------------
const DEUTAN: number[][] = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.011820, 0.042940, 0.968881],
];
const CAT_CHROMA = 0.5;

/** Simulate how an sRGB hex color roughly appears to a cat, as a displayable hex. */
export function catHex(hex: string): string {
  const c = rgb(hex);
  if (!c) return hex;
  const lr = srgbToLinear(c.r);
  const lg = srgbToLinear(c.g);
  const lb = srgbToLinear(c.b);
  const R = clamp01(DEUTAN[0][0] * lr + DEUTAN[0][1] * lg + DEUTAN[0][2] * lb);
  const G = clamp01(DEUTAN[1][0] * lr + DEUTAN[1][1] * lg + DEUTAN[1][2] * lb);
  const B = clamp01(DEUTAN[2][0] * lr + DEUTAN[2][1] * lg + DEUTAN[2][2] * lb);
  const lch = oklch({
    mode: 'rgb' as const,
    r: linearToSrgb(R),
    g: linearToSrgb(G),
    b: linearToSrgb(B),
  });
  if (!lch) return hex;
  lch.c = (lch.c ?? 0) * CAT_CHROMA;
  return formatHex(clampChroma(lch, 'oklch')) ?? hex;
}

// ---------------------------------------------------------------------
// Conversions & distances
// ---------------------------------------------------------------------

/** Convert an sRGB hex to OKLab coordinates. */
export function toLab(hex: string): Lab {
  const o = oklab(hex);
  return o ? { l: o.l ?? 0, a: o.a ?? 0, b: o.b ?? 0 } : { l: 0, a: 0, b: 0 };
}

/** Full simulation: human OKLab, cat RNL coords, and a displayable cat hex. */
export function simulate(hex: string): Sim & { catHex: string } {
  return { human: toLab(hex), catXY: catSpace(hex), catHex: catHex(hex) };
}

// ---------------------------------------------------------------------
// Inverse: cat RNL location -> its metamer set.
// catSpace fixes only the two cat cone catches (S, L) — two linear constraints
// on the 3-D linear-sRGB cube — so the preimage of any plotted point is a LINE.
// Every sRGB color on that line collapses to the same point in cat space, i.e.
// a cat cannot tell them apart. We solve the line, clip it to the gamut cube,
// and sample. This is what makes "click a spot, see the colors there" exact.
// ---------------------------------------------------------------------
const dot3 = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
// A returned color must round-trip to within this RNL distance (JND) of the
// clicked location to count as a genuine metamer. Well under the ~1 JND a cat
// can perceive, so any two survivors are <2× this apart — still indistinguishable.
const METAMER_TOL = 0.4;

/**
 * Human sRGB colors that all map to the given cat RNL location (its metamer set),
 * sampled evenly along the in-gamut segment of the metamer line. Returns `[]`
 * when the location lies outside the sRGB gamut (no color reaches it). Each
 * `cat` field is that color's illustrative cat rendering, so a caller can show
 * the single appearance the whole set shares.
 */
export function catMetamers(loc: XY, count = 8): Metamer[] {
  const A = RGB_TO_LMS[0]; // L-cone row
  const C = RGB_TO_LMS[2]; // S-cone row
  // Invert catSpace to recover the target cone catches, then their L/S values.
  const fL = loc.y * E_LUM;
  const fS = loc.x * CHROMA_SCALE + fL;
  const Lt = Math.max(0, Math.exp(fL) - EPS) * WHITE_L;
  const St = Math.max(0, Math.exp(fS) - EPS) * WHITE_S;

  // Minimum-norm particular solution v0 = α·A + β·C (solve the 2×2 Gram system),
  // and the line direction d = A × C (perpendicular to both cone-row normals).
  const aa = dot3(A, A), ac = dot3(A, C), cc = dot3(C, C);
  const det = aa * cc - ac * ac;
  const alpha = (cc * Lt - ac * St) / det;
  const beta = (aa * St - ac * Lt) / det;
  const v0 = [alpha * A[0] + beta * C[0], alpha * A[1] + beta * C[1], alpha * A[2] + beta * C[2]];
  const d = [A[1] * C[2] - A[2] * C[1], A[2] * C[0] - A[0] * C[2], A[0] * C[1] - A[1] * C[0]];

  // Clip the line to [0,1]^3 with the slab method. A hair of slack keeps
  // boundary-only sets (e.g. white, whose only metamer is itself) from collapsing
  // to a numerically-empty interval.
  const SLACK = 1e-6;
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (v0[i] < -SLACK || v0[i] > 1 + SLACK) return []; // line parallel to & outside this face
    } else {
      let t0 = (-SLACK - v0[i]) / d[i];
      let t1 = (1 + SLACK - v0[i]) / d[i];
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
    }
  }
  if (tmin > tmax) return []; // out of gamut

  // The continuous line is exact, but we can only return 8-bit hex colors. The
  // luminance axis is logarithmic, so near black one LSB is a large ΔS: a naive
  // sample can quantize to a color that no longer shares `loc` and that a cat
  // *could* tell apart — breaking the very promise of the set. So oversample,
  // round-trip each candidate through catSpace, and keep only colors that still
  // land within a sub-JND tolerance of `loc`. Where 8-bit precision can't
  // resolve a metamer (deep shadow) this honestly collapses to one color or none.
  const want = Math.max(1, count);
  const samples = Math.max(want * 6, 36);
  const kept: Metamer[] = [];
  let prev = '';
  for (let k = 0; k < samples; k++) {
    const t = samples === 1 ? (tmin + tmax) / 2 : tmin + (tmax - tmin) * (k / (samples - 1));
    const r = clamp01(v0[0] + t * d[0]);
    const g = clamp01(v0[1] + t * d[1]);
    const b = clamp01(v0[2] + t * d[2]);
    const hex = formatHex({ mode: 'rgb' as const, r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) });
    if (!hex || hex === prev) continue; // skip neighbours that quantization fused
    prev = hex;
    const back = catSpace(hex);
    if (Math.hypot(back.x - loc.x, back.y - loc.y) > METAMER_TOL) continue; // quantization split it off the line
    kept.push({ hex, cat: catHex(hex) });
  }
  if (kept.length <= want) return kept;
  // Thin the survivors to an evenly-spaced subset that still spans the segment.
  const out: Metamer[] = [];
  let last = '';
  for (let i = 0; i < want; i++) {
    const idx = want === 1 ? (kept.length - 1) >> 1 : Math.round((i * (kept.length - 1)) / (want - 1));
    if (kept[idx].hex !== last) {
      out.push(kept[idx]);
      last = kept[idx].hex;
    }
  }
  return out;
}

/** Euclidean distance in OKLab. */
export function labDist(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

// One OKLab ΔE ≈ J_HUMAN ≈ 1 JND for moderate differences (uncalibrated default).
const J_HUMAN = 0.02;
const humanDistJND = (a: Lab, b: Lab) => labDist(a, b) / J_HUMAN;
const catDistJND = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Blended separation between two colors, in JND.
 *   w = 0 -> pure human (OKLab)
 *   w = 1 -> pure cat (RNL cone space)
 * Both terms are in JND units, so this is an honest linear interpolation.
 */
export function separation(a: Sim, b: Sim, w: number): number {
  return (1 - w) * humanDistJND(a.human, b.human) + w * catDistJND(a.catXY, b.catXY);
}

/** Min pairwise separation over a palette, plus the offending pair's indices. */
export function paletteScore(sims: Sim[], w: number): { min: number; worst: [number, number] } {
  let min = Infinity;
  let worst: [number, number] = [-1, -1];
  for (let i = 0; i < sims.length; i++) {
    for (let j = i + 1; j < sims.length; j++) {
      const d = separation(sims[i], sims[j], w);
      if (d < min) {
        min = d;
        worst = [i, j];
      }
    }
  }
  return { min, worst };
}

// ---------------------------------------------------------------------
// Legibility
// ---------------------------------------------------------------------

/** WCAG 2.x contrast ratio (1..21) between two colors. */
export function contrastRatio(hex: string, bg: string): number {
  const l1 = wcagLuminance(hex);
  const l2 = wcagLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better as a label on top of `hex`. */
export function labelColor(hex: string): string {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#ffffff' : '#000000';
}

/** True if `hex` is a light background — i.e. a map color the page should mirror. */
export function isLightBackground(hex: string): boolean {
  return (wcagLuminance(hex) ?? 0) > 0.5;
}
