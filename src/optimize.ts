import { formatHex, clampChroma } from 'culori';
import { simulate, contrastRatio, separation, type Sim } from './color';

interface Candidate {
  hex: string;
  sim: Sim;
}

export interface OptimizeParams {
  /** Locked colors, kept exactly as-is and used as fixed references. */
  anchors: string[];
  /** How many non-locked entries to (re)generate. */
  freeCount: number;
  /** Human<->cat blend weight (0..1). */
  catWeight: number;
  /** Map background, for the contrast filter. */
  background: string;
  /** Minimum WCAG contrast every candidate must clear against the background. */
  minContrast: number;
}

// Candidate gamut: an OKLCh grid. Lightness levels avoid the extremes; chroma
// spans muted->vivid; 36 hues = every 10°.
const L_LEVELS = [0.42, 0.5, 0.58, 0.66, 0.74, 0.82];
const C_LEVELS = [0.06, 0.1, 0.14, 0.19, 0.25, 0.31];
const H_STEPS = 36;
const RESTARTS = 12;
const ANNEAL_ITERS = 700;
// Starting annealing temperature. Separations are now in JND (~5–50), so this
// is much larger than the old OKLab-scale value.
const ANNEAL_T0 = 6;
// Keep any run scoring within this fraction of the best, then pick among them at
// random — trades a sliver of optimality for fresh palettes on every recompute.
const NEAR_BEST = 0.95;

function buildCandidates(background: string, minContrast: number, hueOffset: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const l of L_LEVELS) {
    for (const c of C_LEVELS) {
      for (let h = 0; h < H_STEPS; h++) {
        const hue = ((h * 360) / H_STEPS + hueOffset) % 360;
        const color = clampChroma({ mode: 'oklch' as const, l, c, h: hue }, 'oklch');
        const hex = formatHex(color);
        if (!hex || seen.has(hex)) continue;
        if (contrastRatio(hex, background) < minContrast) continue;
        seen.add(hex);
        const s = simulate(hex);
        out.push({ hex, sim: { human: s.human, catXY: s.catXY } });
      }
    }
  }
  return out;
}

function minDistTo(sim: Sim, refs: Sim[], w: number): number {
  let m = Infinity;
  for (const r of refs) {
    const d = separation(sim, r, w);
    if (d < m) m = d;
  }
  return m;
}

function scoreAll(sims: Sim[], w: number): number {
  let m = Infinity;
  for (let i = 0; i < sims.length; i++) {
    for (let j = i + 1; j < sims.length; j++) {
      const d = separation(sims[i], sims[j], w);
      if (d < m) m = d;
    }
  }
  return m;
}

/** Greedy farthest-point seeding (Gonzalez 1985): factor-2 approx to max-min. */
function greedy(cands: Candidate[], anchors: Sim[], freeCount: number, w: number, startIdx: number): Candidate[] {
  const chosen: Candidate[] = [];
  const refs: Sim[] = anchors.slice();
  const used = new Set<number>();
  for (let k = 0; k < freeCount && used.size < cands.length; k++) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue;
      // With no references yet, force the first pick to `startIdx` so restarts diverge.
      const m = refs.length === 0 ? (i === startIdx ? Infinity : -1) : minDistTo(cands[i].sim, refs, w);
      if (m > bestScore) {
        bestScore = m;
        best = i;
      }
    }
    if (best < 0) break;
    used.add(best);
    chosen.push(cands[best]);
    refs.push(cands[best].sim);
  }
  return chosen;
}

/** Simulated-annealing polish over the free entries; anchors stay fixed. */
function anneal(cands: Candidate[], anchors: Sim[], free: Candidate[], w: number): Candidate[] {
  if (free.length === 0 || cands.length === 0) return free;
  const cur = free.slice();
  const sims = () => [...anchors, ...cur.map((c) => c.sim)];
  let curScore = scoreAll(sims(), w);
  let best = cur.slice();
  let bestScore = curScore;
  let T = ANNEAL_T0;
  for (let it = 0; it < ANNEAL_ITERS; it++) {
    const idx = Math.floor(Math.random() * cur.length);
    const prev = cur[idx];
    cur[idx] = cands[Math.floor(Math.random() * cands.length)];
    const ns = scoreAll(sims(), w);
    if (ns > curScore || Math.random() < Math.exp((ns - curScore) / T)) {
      curScore = ns;
      if (ns > bestScore) {
        bestScore = ns;
        best = cur.slice();
      }
    } else {
      cur[idx] = prev; // reject
    }
    T *= 0.997;
  }
  return best;
}

/**
 * Recompute colors for the free entries, maximizing the minimum blended
 * human/cat separation while treating `anchors` as immovable. Returns one hex
 * per free entry (may be shorter if the gamut is exhausted).
 */
export function optimizePalette(p: OptimizeParams): string[] {
  if (p.freeCount <= 0) return [];
  // Random sub-grid hue jitter so the candidate set differs run-to-run.
  const hueOffset = Math.random() * (360 / H_STEPS);
  const cands = buildCandidates(p.background, p.minContrast, hueOffset);
  if (cands.length === 0) return [];
  const anchorSims: Sim[] = p.anchors.map((h) => {
    const s = simulate(h);
    return { human: s.human, catXY: s.catXY };
  });

  // Collect every restart's solution. Because each greedy run starts from a
  // random hue, the runs land on different *rotations* of the (rotationally
  // symmetric) optimal spread — all scoring about the same.
  const sols: Array<{ sol: Candidate[]; score: number }> = [];
  for (let r = 0; r < RESTARTS; r++) {
    const startIdx = Math.floor(Math.random() * cands.length);
    let sol = greedy(cands, anchorSims, p.freeCount, p.catWeight, startIdx);
    sol = anneal(cands, anchorSims, sol, p.catWeight);
    const score = scoreAll([...anchorSims, ...sol.map((c) => c.sim)], p.catWeight);
    sols.push({ sol, score });
  }

  // Pick at random among the near-best runs (within NEAR_BEST of the top score)
  // so repeated clicks yield genuinely different — but still well-separated —
  // palettes instead of always converging on the same one.
  const top = Math.max(...sols.map((s) => s.score));
  const pool = sols.filter((s) => s.score >= top * NEAR_BEST);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return chosen.sol.map((c) => c.hex);
}
