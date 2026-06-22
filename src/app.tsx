import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  catGamutBoundary,
  catHex,
  catMetamers,
  catShade,
  catShadeBelowContrast,
  catSpace,
  contrastRatio,
  hexToHsl,
  hslToHex,
  isLightBackground,
  legibleTextOn,
  metamerColorAt,
  metamerLine,
  metamerPosition,
  paletteScore,
  relativeLuminance,
  simulate,
  type Hsl,
  type MetamerLine,
  type Metamer,
  type Sim,
  type XY,
} from './color';
import { optimizePalette } from './optimize';
import { Scatter, closestPair, type Pt } from './components/Scatter';
import { MetamerPopup } from './components/MetamerPopup';
import type { Entry, State } from './types';

const MAX_ENTRIES = 20;
const SOFT_CAP = 12;
const COALESCE_MS = 500; // rapid same-source changes within this window = one undo step
const MAX_HISTORY = 100;

// The optimizer and palette score weight human and cat separation equally. This
// used to be a user-facing "optimize for" slider; it's now fixed at the tool's
// core premise — palettes that stay distinct for both. State still carries a
// catWeight field (so older saved palettes/URLs decode), but the app drives the
// solve and the score from this constant so the two never drift apart.
const CAT_WEIGHT = 0.5;

/** Normalize a 3- or 6-digit hex (with or without leading #) to "#rrggbb", or null. */
function normHex(raw: string): string | null {
  let v = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(v) ? '#' + v.toLowerCase() : null;
}

type ParsedPalette = { name: string | null; colors: Array<{ color: string; locked: boolean; code?: string }> };

/** Parse a pasted palette: a catsafe JSON export, a JSON array, or loose hex tokens. */
function parsePalette(text: string): ParsedPalette {
  const t = text.trim();
  if (!t) return { name: null, colors: [] };
  try {
    const j = JSON.parse(t);
    // New exports are { name, colors: [...] }; older ones are a bare array.
    const arr = Array.isArray(j) ? j : Array.isArray(j?.colors) ? j.colors : null;
    if (arr) {
      const out: Array<{ color: string; locked: boolean; code?: string }> = [];
      for (const x of arr) {
        if (typeof x === 'string') {
          const h = normHex(x);
          if (h) out.push({ color: h, locked: false });
        } else if (x && typeof x === 'object') {
          const h = normHex(String(x.human ?? x.color ?? x.hex ?? ''));
          // New exports carry the service code in "line"; ignore the legacy numeric form.
          const rawCode = typeof x.code === 'string' ? x.code : typeof x.line === 'string' ? x.line : '';
          if (h) out.push({ color: h, locked: !!x.locked, code: rawCode || undefined });
        }
      }
      if (out.length) {
        const name = !Array.isArray(j) && typeof j.name === 'string' ? j.name : null;
        return { name, colors: out };
      }
    }
  } catch {
    /* not JSON — fall through to token scan */
  }
  const tokens = t.match(/#?[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? [];
  const out: Array<{ color: string; locked: boolean }> = [];
  for (const tok of tokens) {
    const h = normHex(tok);
    if (h) out.push({ color: h, locked: false });
  }
  return { name: null, colors: out };
}

/** Nearest plotted point to a data-space location, with its distance (the cat
 *  plot's coords are RNL, so this distance is a ΔS). */
function nearestPoint(loc: XY, pts: Pt[]): { pt: Pt; d: number } | null {
  let best: { pt: Pt; d: number } | null = null;
  for (const p of pts) {
    const d = Math.hypot(loc.x - p.x, loc.y - p.y);
    if (!best || d < best.d) best = { pt: p, d };
  }
  return best;
}

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/** Spreadsheet-style column label: 0→A, 25→Z, 26→AA, 27→AB, … */
function colLabel(n: number): string {
  let s = '';
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) {
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  }
  return s;
}

/** Normalize a typed service code: uppercase, alphanumeric only, max 2 chars. */
const normCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);

/** First default code (A, B, C, …) not already taken, so adds fill any gaps. */
function nextCode(entries: Entry[]): string {
  const used = new Set(entries.map((e) => e.code));
  for (let i = 0; ; i++) {
    const c = colLabel(i);
    if (!used.has(c)) return c;
  }
}

/** Display/export identifier: the entry's code, falling back to its positional label. */
const codeOf = (entry: Entry, index: number) => entry.code || colLabel(index);

const mk = (color: string, locked = false, code = ''): Entry => ({
  id: uid(),
  code,
  color,
  locked,
});

const DEFAULT_STATE: State = {
  name: '',
  entries: ['#c1272d', '#0061a8', '#1f9e57', '#e58a00', '#6a3d9a'].map((c, i) => mk(c, false, colLabel(i))),
  catWeight: 0.5,
  background: '#ffffff',
  minContrast: 3,
};

// --- persistence (URL hash + localStorage) -----------------------------------

function encode(s: State): string {
  return btoa(encodeURIComponent(JSON.stringify(s)));
}
function decode(str: string): State | null {
  try {
    const s = JSON.parse(decodeURIComponent(atob(str)));
    if (s && Array.isArray(s.entries) && typeof s.catWeight === 'number') return s as State;
  } catch {
    /* ignore */
  }
  return null;
}
/** Backfill service codes on states saved before codes existed. A deliberately
 *  cleared code ("") is a string and is preserved; only a missing field is filled. */
function ensureCodes(s: State): State {
  if (s.entries.every((e) => typeof e.code === 'string')) return s;
  return { ...s, entries: s.entries.map((e, i) => (typeof e.code === 'string' ? e : { ...e, code: colLabel(i) })) };
}
function loadInitial(): State {
  if (location.hash.startsWith('#p=')) {
    const s = decode(location.hash.slice(3));
    if (s) return ensureCodes(s);
  }
  try {
    const raw = localStorage.getItem('catsafe');
    if (raw) {
      const s = decode(raw);
      if (s) return ensureCodes(s);
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_STATE;
}

type Theme = 'light' | 'dark';
/** Page light/dark theme — an independent, persisted UI preference, no longer tied
 *  to the map background. First run with nothing saved falls back to what the map
 *  background used to imply, so the page looks unchanged the first time after the
 *  two were decoupled. */
function loadTheme(bg: string): Theme {
  try {
    const t = localStorage.getItem('catsafe-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return isLightBackground(bg) ? 'light' : 'dark';
}

// --- per-entry row -----------------------------------------------------------

/** Numeric H/S/L field. The native spinner, ↑/↓ keys, and wheel-over all nudge
 *  by `step` (0.5); values carry one decimal place. Uncontrolled so the field
 *  owns its text buffer while typing — we only write back when `value` changes
 *  from outside (and the field isn't focused). */
function HslInput(props: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const { label, title, value, min, max, step, onChange } = props;
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = value.toFixed(1);
  }, [value]);

  // Clamp to range and snap to one decimal so the stored HSL matches the display.
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    onChange(Math.round(Math.min(max, Math.max(min, n)) * 10) / 10);
  };

  // Drive the wheel through the native stepper so it snaps and clamps exactly
  // like the arrows and spinner do.
  const onWheel = (e: WheelEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    if (e.deltaY < 0) el.stepUp();
    else el.stepDown();
    commit(el.value);
  };

  return (
    <label class="hsl-field" title={title}>
      <span class="hsl-label">{label}</span>
      <input
        ref={ref}
        class="hsl-num"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        defaultValue={value.toFixed(1)}
        onInput={(e) => commit((e.target as HTMLInputElement).value)}
        onWheel={onWheel}
        onBlur={(e) => {
          (e.target as HTMLInputElement).value = value.toFixed(1);
        }}
      />
    </label>
  );
}

function EntryRow(props: {
  entry: Entry;
  index: number;
  bg: string;
  minContrast: number;
  isWorst: boolean;
  onEdit: (id: string, color: string, coalesceKey?: string) => void;
  onCode: (id: string, code: string) => void;
  onToggleLock: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { entry, index, bg, minContrast, isWorst, onEdit, onCode, onToggleLock, onRemove } = props;
  const cat = catHex(entry.color);
  const cr = contrastRatio(entry.color, bg);
  const lowContrast = cr < minContrast;

  // HSL is the editable representation; hex stays the source of truth in state.
  // Keeping a local triplet makes 0.5 steps exact — round-tripping every nudge
  // through 8-bit hex would quantize fine hue/sat moves. Re-sync only when the
  // color changes from outside this row (recompute, undo, load), not from our
  // own edit (which we recognize by the hex we last emitted).
  const [hslState, setHslState] = useState<Hsl>(() => hexToHsl(entry.color));
  const lastEmitted = useRef(entry.color);
  useEffect(() => {
    if (entry.color !== lastEmitted.current) {
      setHslState(hexToHsl(entry.color));
      lastEmitted.current = entry.color;
    }
  }, [entry.color]);
  const setChannel = (patch: Partial<Hsl>) => {
    const next = { ...hslState, ...patch };
    setHslState(next);
    const hex = hslToHex(next);
    lastEmitted.current = hex;
    onEdit(entry.id, hex, `hsl:${entry.id}`);
  };

  // Click a swatch to copy its hex; double-click the human swatch to edit it.
  const [copied, setCopied] = useState<'human' | 'cat' | null>(null);
  const copyTimer = useRef<number | null>(null);
  const clickTimer = useRef<number | null>(null);
  const flashCopied = (which: 'human' | 'cat', hex: string) => {
    navigator.clipboard?.writeText(hex);
    setCopied(which);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1000);
  };

  const [editing, setEditing] = useState(false);
  const [hexDraft, setHexDraft] = useState(entry.color);
  const hexRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (editing) {
      const el = hexRef.current;
      el?.focus();
      el?.select();
    }
  }, [editing]);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  // Debounce the single-click copy so a double-click (to edit) doesn't also copy.
  const onHumanClick = () => {
    if (editing || clickTimer.current) return;
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      flashCopied('human', entry.color);
    }, 200);
  };
  const onHumanDblClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    setHexDraft(entry.color);
    doneRef.current = false;
    setEditing(true);
  };
  // Guarded so the trailing blur after Enter/Escape can't commit a second time.
  const finishEdit = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (save) {
      const norm = normHex(hexDraft);
      if (norm) onEdit(entry.id, norm);
    }
    setEditing(false);
  };

  const lockLabel = entry.locked ? '🔒' : '🔓';
  const lockTitle = entry.locked ? 'Locked — click to unlock' : 'Unlocked — click to lock';

  return (
    <div class={`row${isWorst ? ' worst' : ''}${entry.locked ? ' locked' : ''}`}>
      <input
        class="line-code"
        type="text"
        spellcheck={false}
        maxLength={2}
        value={entry.code}
        aria-label={`Service code (currently ${codeOf(entry, index)})`}
        onInput={(e) => onCode(entry.id, (e.target as HTMLInputElement).value)}
      />

      <div class="swatches">
        <div
          class="swatch interactive"
          style={{ background: entry.color, color: legibleTextOn(entry.color) }}
          onClick={onHumanClick}
          onDblClick={onHumanDblClick}
          title="Click to copy · double-click to edit"
        >
          {editing ? (
            <input
              ref={hexRef}
              class="swatch-hex-edit"
              type="text"
              spellcheck={false}
              value={hexDraft}
              aria-label={`Edit hex for line ${codeOf(entry, index)}`}
              onClick={(e) => e.stopPropagation()}
              onDblClick={(e) => e.stopPropagation()}
              onInput={(e) => setHexDraft((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishEdit(true);
                else if (e.key === 'Escape') finishEdit(false);
              }}
              onBlur={() => finishEdit(true)}
            />
          ) : (
            <>
              <span class="sw-label">human</span>
              <span class="sw-hex">{copied === 'human' ? 'copied ✓' : entry.color}</span>
            </>
          )}
        </div>
        <div
          class="swatch interactive"
          style={{ background: cat, color: legibleTextOn(cat) }}
          onClick={() => flashCopied('cat', cat)}
          title="Click to copy"
        >
          <span class="sw-label">cat</span>
          <span class="sw-hex">{copied === 'cat' ? 'copied ✓' : cat}</span>
        </div>
      </div>

      <div class="row-controls">
        <div class="hsl-group">
          <HslInput
            label="H"
            title="Hue (0–360°)"
            value={hslState.h}
            min={0}
            max={360}
            step={1}
            onChange={(h) => setChannel({ h })}
          />
          <HslInput
            label="S"
            title="Saturation (0–100%)"
            value={hslState.s}
            min={0}
            max={100}
            step={0.5}
            onChange={(s) => setChannel({ s })}
          />
          <HslInput
            label="L"
            title="Lightness (0–100%)"
            value={hslState.l}
            min={0}
            max={100}
            step={0.5}
            onChange={(l) => setChannel({ l })}
          />
        </div>
        <span class={`contrast${lowContrast ? ' bad' : ''}`} title="WCAG contrast vs background">
          {cr.toFixed(1)}:1
        </span>
        <button class={`lock${entry.locked ? ' on' : ''}`} title={lockTitle} onClick={() => onToggleLock(entry.id)}>
          {lockLabel}
        </button>
        <button class="remove" title="Remove line" onClick={() => onRemove(entry.id)}>
          ✕
        </button>
      </div>
    </div>
  );
}

// --- selected-color bar ------------------------------------------------------

/** Edit controls for the dot the user clicked in either plot. A trimmed EntryRow:
 *  the same human/cat swatches and H/S/L fields, plus a metamer slider that moves
 *  the color along the red↔green axis a cat can't see (cat color held constant).
 *  No lock/remove. Faded with a "no selection" message when nothing is selected. */
function SelectedColorBar(props: {
  entry: Entry | null;
  label: string;
  onEdit: (id: string, color: string, coalesceKey?: string) => void;
}) {
  const { entry, label, onEdit } = props;
  // A neutral placeholder keeps the (faded, inert) controls rendered when nothing
  // is selected, so the bar holds its height instead of collapsing.
  const color = entry?.color ?? '#888888';
  const cat = catHex(color);

  // Local HSL triplet for exact 0.5 nudges (same rationale as EntryRow); re-synced
  // when the color changes from outside — new selection, metamer slide, or undo.
  const [hsl, setHsl] = useState<Hsl>(() => hexToHsl(color));
  const lastEmitted = useRef(color);
  useEffect(() => {
    if (color !== lastEmitted.current) {
      setHsl(hexToHsl(color));
      lastEmitted.current = color;
    }
  }, [color]);
  const setChannel = (patch: Partial<Hsl>) => {
    if (!entry) return;
    const next = { ...hsl, ...patch };
    setHsl(next);
    const hex = hslToHex(next);
    lastEmitted.current = hex;
    onEdit(entry.id, hex, `hsl:${entry.id}`);
  };

  // The in-gamut metamer segment through this color's cat location. Sliding it
  // rewrites the human color along MET_D while the two cat cone catches — and so
  // the cat dot's position — stay put.
  //
  // The line is ANCHORED in a ref, not re-derived from `color` every render. A
  // committed color is 8-bit quantized, so catSpace(hex) lands a hair off the line;
  // re-deriving from it each drag step would let the line — and the cat dot — drift
  // cumulatively (loc += ε every commit), meandering badly on slow drags and
  // stalling once the wander clamps into the gamut edge (line → null). With a fixed
  // line, each commit is a single bounded error off loc, never accumulating. We
  // re-anchor only when `color` changes for a reason OTHER than our own metamer
  // commit — new selection, H/S/L edit, undo, recompute — tracked via metaCommitted.
  const metaCommitted = useRef<string | null>(null);
  const metaAnchor = useRef<{ src: string; line: MetamerLine | null }>({ src: '', line: null });
  if (metaAnchor.current.src !== color && color !== metaCommitted.current) {
    metaAnchor.current = { src: color, line: metamerLine(catSpace(color)) };
    metaCommitted.current = null;
  }
  const line = metaAnchor.current.line;
  // Degenerate (e.g. near-black, where 8-bit resolves no spread) → disable the slider.
  const metaRange = line ? line.tmax - line.tmin : 0;
  const metaPos = line ? metamerPosition(line, color) : 0.5;
  const setMeta = (s: number) => {
    if (!entry || !line) return;
    const hex = metamerColorAt(line, s);
    metaCommitted.current = hex;
    // Unlike setChannel, don't mark this hex as "self-emitted" for the H/S/L sync:
    // the fields aren't what changed, so they re-sync to the new color below.
    onEdit(entry.id, hex, `meta:${entry.id}`);
  };

  // The thumb is uncontrolled (like HslInput) for a smooth drag: write its position
  // imperatively when the color moves from outside the slider, but never mid-drag
  // (skip while it's focused), so a controlled re-render can't fight the cursor.
  const metaRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = metaRef.current;
    if (el && document.activeElement !== el) el.value = String(metaPos);
  }, [metaPos]);

  // Click a swatch to copy its hex (matches the palette rows).
  const [copied, setCopied] = useState<'human' | 'cat' | null>(null);
  const copyTimer = useRef<number | null>(null);
  const flashCopied = (which: 'human' | 'cat', hex: string) => {
    navigator.clipboard?.writeText(hex);
    setCopied(which);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1000);
  };
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  return (
    <div class={`selected-bar${entry ? '' : ' empty'}`}>
      <div class="selected-head">
        Selected color{entry && <span class="selected-code"> · line {label}</span>}
      </div>
      <div class="selected-body">
        <div class="swatches">
          <div
            class="swatch interactive"
            style={{ background: color, color: legibleTextOn(color) }}
            onClick={() => entry && flashCopied('human', color)}
            title="Click to copy"
          >
            <span class="sw-label">human</span>
            <span class="sw-hex">{copied === 'human' ? 'copied ✓' : color}</span>
          </div>
          <div
            class="swatch interactive"
            style={{ background: cat, color: legibleTextOn(cat) }}
            onClick={() => entry && flashCopied('cat', cat)}
            title="Click to copy"
          >
            <span class="sw-label">cat</span>
            <span class="sw-hex">{copied === 'cat' ? 'copied ✓' : cat}</span>
          </div>
        </div>

        <div class="selected-controls">
          <div class="hsl-group">
            <HslInput label="H" title="Hue (0–360°)" value={hsl.h} min={0} max={360} step={1} onChange={(h) => setChannel({ h })} />
            <HslInput label="S" title="Saturation (0–100%)" value={hsl.s} min={0} max={100} step={0.5} onChange={(s) => setChannel({ s })} />
            <HslInput label="L" title="Lightness (0–100%)" value={hsl.l} min={0} max={100} step={0.5} onChange={(l) => setChannel({ l })} />
          </div>
          <div class="metamer-control">
            <label for="sel-metamer">Slide along metamer — cat sees no change</label>
            <div class="slider-row">
              <span>greener</span>
              <input
                ref={metaRef}
                id="sel-metamer"
                type="range"
                min="0"
                max="1"
                step="0.005"
                defaultValue={String(metaPos)}
                disabled={!entry || metaRange < 1e-4}
                aria-label="Move the selected color along its metamer (the red–green axis a cat can't see)"
                onInput={(e) => setMeta(parseFloat((e.target as HTMLInputElement).value))}
              />
              <span>redder</span>
            </div>
          </div>
        </div>
      </div>
      {!entry && (
        <div class="selected-empty">
          <span>No color selected — click a dot in either plot to edit it.</span>
        </div>
      )}
    </div>
  );
}

// --- app ---------------------------------------------------------------------

type HistState = { present: State; past: State[]; future: State[] };

export function App() {
  const [hist, setHist] = useState<HistState>(() => ({ present: loadInitial(), past: [], future: [] }));
  const [busy, setBusy] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadText, setLoadText] = useState('');
  const [loadErr, setLoadErr] = useState('');
  // A spot the user clicked in the cat plot, plus the metamer colors there.
  const [pick, setPick] = useState<{ loc: XY; screen: { x: number; y: number }; metamers: Metamer[] } | null>(null);
  // The palette entry currently selected (by clicking its dot), edited in the
  // selected-color bar under the plots. Tracked by id so it survives reordering.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Page light/dark theme — decoupled from the map background, toggled in the
  // toolbar and persisted in localStorage.
  const [theme, setTheme] = useState<Theme>(() => loadTheme(hist.present.background));
  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  const state = hist.present;
  const { entries, background, minContrast } = state;
  const name = state.name ?? ''; // legacy saved states predate this field
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  // Changes sharing a coalesce key within COALESCE_MS collapse into one undo
  // step (slider drags, dragging the OS color picker). Discrete edits pass no
  // key and always make their own step.
  const coalesce = useRef<{ key: string | null; t: number }>({ key: null, t: 0 });

  const apply = (producer: (s: State) => State, key?: string) => {
    const now = performance.now();
    const c = coalesce.current;
    const sameGroup = key != null && key === c.key && now - c.t < COALESCE_MS;
    coalesce.current = { key: key ?? null, t: now };
    setHist((h) => {
      const present = producer(h.present);
      if (sameGroup) return { ...h, present, future: [] };
      return { present, past: [...h.past, h.present].slice(-MAX_HISTORY), future: [] };
    });
  };

  const undo = () => {
    coalesce.current = { key: null, t: 0 };
    setHist((h) =>
      h.past.length
        ? { present: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.present, ...h.future] }
        : h,
    );
  };
  const redo = () => {
    coalesce.current = { key: null, t: 0 };
    setHist((h) =>
      h.future.length ? { present: h.future[0], past: [...h.past, h.present], future: h.future.slice(1) } : h,
    );
  };

  // The map background colors the bullet panel (so the palette is seen on the
  // surface it'll sit on); the page light/dark theme is now an independent toggle.
  // --page-bg carries the tested color to the bullet panel; the `light` class
  // applies the chosen theme. useLayoutEffect applies both before paint to avoid a
  // theme flash on load.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--page-bg', background);
    // The cat-plot "below contrast" wash is tied to the map, not the page theme:
    // the map's own contrasting ink (black on a light map, white on a dark one), so
    // it always dims/marks those spots rather than brightening them in dark theme.
    root.style.setProperty('--low-contrast-wash', legibleTextOn(background));
    root.classList.toggle('light', theme === 'light');
  }, [background, theme]);

  // Persist the theme preference (separate key from the palette state).
  useEffect(() => {
    try {
      localStorage.setItem('catsafe-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    const enc = encode(state);
    try {
      localStorage.setItem('catsafe', enc);
    } catch {
      /* ignore */
    }
    try {
      history.replaceState(null, '', '#p=' + enc);
    } catch {
      /* ignore */
    }
  }, [state]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) = redo. Skipped while a text
  // field is focused so the browser's native text undo still works there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ae = document.activeElement as HTMLElement | null;
      const editable =
        !!ae &&
        (ae.tagName === 'TEXTAREA' ||
          (ae.tagName === 'INPUT' &&
            ['text', 'number', 'search', 'url', 'email', 'password'].includes((ae as HTMLInputElement).type)));
      if (editable) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sims = useMemo<Array<Sim & { catHex: string; hex: string }>>(
    () => entries.map((e) => ({ ...simulate(e.color), hex: e.color })),
    [entries],
  );
  const score = useMemo(() => paletteScore(sims, CAT_WEIGHT), [sims]);
  const [wi, wj] = score.worst;

  const update = (patch: Partial<State>, key?: string) => apply((s) => ({ ...s, ...patch }), key);
  const setEntries = (fn: (e: Entry[]) => Entry[]) => apply((s) => ({ ...s, entries: fn(s.entries) }));

  const onEdit = (id: string, color: string, coalesceKey?: string) =>
    apply(
      (s) => ({
        ...s,
        entries: s.entries.map((e) => (e.id === id ? { ...e, color, locked: true } : e)),
      }),
      coalesceKey,
    );

  const onCode = (id: string, code: string) =>
    apply(
      (s) => ({ ...s, entries: s.entries.map((e) => (e.id === id ? { ...e, code: normCode(code) } : e)) }),
      `code:${id}`,
    );

  const onToggleLock = (id: string) =>
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, locked: !e.locked } : e)));

  const onRemove = (id: string) => setEntries((es) => es.filter((e) => e.id !== id));
  const onAdd = () =>
    setEntries((es) => (es.length >= MAX_ENTRIES ? es : [...es, mk('#777777', false, nextCode(es))]));

  const recompute = () => {
    setBusy(true);
    // Defer so the "Computing…" state can paint before the synchronous solve.
    setTimeout(() => {
      apply((s) => {
        const anchors = s.entries.filter((e) => e.locked).map((e) => e.color);
        const freeCount = s.entries.length - anchors.length;
        const colors = optimizePalette({
          anchors,
          freeCount,
          catWeight: CAT_WEIGHT,
          background: s.background,
          minContrast: s.minContrast,
        });
        let k = 0;
        const next = s.entries.map((e) => (e.locked ? e : { ...e, color: colors[k++] ?? e.color }));
        return { ...s, entries: next };
      });
      setBusy(false);
    }, 10);
  };

  // exports
  const copy = (text: string) => navigator.clipboard?.writeText(text);
  const exportHex = () => copy(entries.map((e) => e.color).join('\n'));
  const exportCss = () => copy(entries.map((e, i) => `  --line-${codeOf(e, i)}: ${e.color};`).join('\n'));
  const exportJson = () => {
    const paletteName = name.trim() || 'Untitled palette';
    const data = JSON.stringify(
      {
        name: paletteName,
        colors: entries.map((e, i) => ({ line: codeOf(e, i), human: e.color, cat: catHex(e.color), locked: e.locked })),
      },
      null,
      2,
    );
    const slug = paletteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (slug || 'catsafe-palette') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // load / import
  const openLoad = () => {
    setLoadText('');
    setLoadErr('');
    setLoadOpen(true);
  };
  const onLoadFile = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLoadText(String(reader.result ?? ''));
    reader.readAsText(file);
  };
  const doLoad = () => {
    const parsed = parsePalette(loadText);
    if (parsed.colors.length === 0) {
      setLoadErr('No colors found. Paste hex values (e.g. #1a2b3c) or a catsafe JSON export.');
      return;
    }
    const next = parsed.colors
      .slice(0, MAX_ENTRIES)
      .map((p, i) => mk(p.color, p.locked, p.code ? normCode(p.code) : colLabel(i)));
    apply((s) => ({ ...s, entries: next, name: parsed.name ?? s.name }));
    setLoadOpen(false);
  };

  const humanPts = sims.map((s, i) => ({
    x: s.human.a,
    y: s.human.b,
    fill: s.hex,
    humanHex: s.hex,
    catHex: s.catHex,
    label: codeOf(entries[i], i),
  }));
  const catPts = sims.map((s, i) => ({
    x: s.catXY.x,
    y: s.catXY.y,
    fill: s.catHex,
    humanHex: s.hex,
    catHex: s.catHex,
    label: codeOf(entries[i], i),
  }));
  // The sRGB gamut's image in cat cone space — constant, so compute it once.
  const catGamut = useMemo(() => catGamutBoundary(), []);

  // Shade the cat plot with one representative human color per spot. metamerS picks
  // where along each spot's red↔green metamer spread to sample (0 = greener end,
  // 1 = redder end, per-spot relative). Memoized on metamerS so the raster only
  // re-renders when the slider moves, not on every unrelated re-render.
  const [metamerS, setMetamerS] = useState(0.5);
  const catShadeCb = useCallback((loc: XY) => catShade(loc, metamerS), [metamerS]);

  // Shade out cat-plot spots whose tint (the same metamer color shown at metamerS)
  // can't reach the WCAG contrast threshold against the current map background — i.e.
  // colors there wouldn't be legible on that background. Hoist the background's
  // luminance so the per-pixel test is just a metamer solve; re-memoize when the
  // background, threshold, or shown metamer changes.
  const bgLum = useMemo(() => relativeLuminance(background), [background]);
  const catDimCb = useCallback(
    (loc: XY) => catShadeBelowContrast(loc, metamerS, bgLum, minContrast),
    [metamerS, bgLum, minContrast],
  );

  // Clicked spot → nearest palette color on the cat plot: the dotted line we draw
  // there and the gap shown in the popover. It reads red when that gap is below
  // the plot's own min separation (the closest pair, same value shown under the
  // plot) — i.e. the click sits closer to a color than the palette's tightest pair.
  const catCp = closestPair(catPts);
  const nearestCat = pick ? nearestPoint(pick.loc, catPts) : null;
  const pickBelowMin = !!(nearestCat && catCp && nearestCat.d < catCp.d);

  // Click a spot in the cat plot to inspect every sRGB color that lands there —
  // the metamer set a cat perceives as one color (see catMetamers).
  const onPickCat = (loc: XY, screen: { x: number; y: number }) =>
    setPick({ loc, screen, metamers: catMetamers(loc) });

  // Selecting a dot (from either plot) opens it in the selected-color bar and
  // dismisses any metamer popover, so the two interactions never overlap. Clicking
  // the already-selected dot toggles it back off (deselect).
  const selectEntry = (id: string) => {
    setSelectedId((cur) => (cur === id ? null : id));
    setPick(null);
  };
  const selIdx = selectedId ? entries.findIndex((e) => e.id === selectedId) : -1;
  const selectedEntry = selIdx >= 0 ? entries[selIdx] : null;

  return (
    <div class="app">
      <header>
        <h1>🐈‍⬛ catsafe</h1>
        <p class="tagline">
          Transit-line color palettes that stay distinct for humans <em>and</em> cats.
        </p>
        <div class="header-row">
          <div class="name-control">
            <label for="palette-name">Palette name</label>
            <input
              id="palette-name"
              class="palette-name"
              type="text"
              value={name}
              spellcheck={false}
              maxLength={60}
              placeholder="Untitled palette"
              aria-label="Palette name"
              onInput={(e) => update({ name: (e.target as HTMLInputElement).value }, 'name')}
            />
          </div>
          <div class="exports">
            <label>Load / export</label>
            <div class="export-row">
              <button class="mini" onClick={openLoad}>
                load…
              </button>
              <span class="export-sep" />
              <button class="mini" onClick={exportHex}>
                hex
              </button>
              <button class="mini" onClick={exportCss}>
                css
              </button>
              <button class="mini" onClick={exportJson}>
                json
              </button>
            </div>
          </div>
        </div>
      </header>

      <section class="toolbar">
        <button class="primary" disabled={busy} onClick={recompute}>
          {busy ? 'Computing…' : '↻ Recompute'}
        </button>
        <button onClick={onAdd} disabled={entries.length >= MAX_ENTRIES}>
          + Add line
        </button>

        <span class="toolbar-sep" />

        <div class="bg-cluster">
          <span class="tb-label">Map bg</span>
          <input
            type="color"
            value={background}
            onInput={(e) => update({ background: (e.target as HTMLInputElement).value }, 'bg')}
          />
          <button class="mini" onClick={() => update({ background: '#ffffff' })}>
            white
          </button>
          <button class="mini" onClick={() => update({ background: '#111317' })}>
            dark
          </button>
          <label class="contrast-field" title="Minimum WCAG contrast colors must keep against the map background">
            <span class="tb-label">contrast {minContrast.toFixed(1)}:1</span>
            <input
              type="range"
              min="1"
              max="7"
              step="0.5"
              value={minContrast}
              onInput={(e) => update({ minContrast: parseFloat((e.target as HTMLInputElement).value) }, 'slider:contrast')}
            />
          </label>
        </div>

        <div class="tb-history">
          <button class="mini" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
            ↶ undo
          </button>
          <button class="mini" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            ↷ redo
          </button>
          <button
            class="mini theme-toggle"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'light' ? 'Night (dark)' : 'Sun (light)'} theme`}
            aria-label={`Switch to ${theme === 'light' ? 'night' : 'sun'} theme`}
          >
            {theme === 'light' ? '🌙 Night' : '☀ Sun'}
          </button>
        </div>
      </section>

      <div class="bullet-row" role="group" aria-label="Palette colors — click a bullet to select that line">
        {entries.map((e, i) => (
          <button
            key={e.id}
            class={`bullet${selIdx === i ? ' selected' : ''}`}
            style={{ background: e.color, color: legibleTextOn(e.color) }}
            title={`Line ${codeOf(e, i)} · ${e.color}`}
            aria-label={`Select line ${codeOf(e, i)}`}
            aria-pressed={selIdx === i}
            onClick={() => selectEntry(e.id)}
          >
            {codeOf(e, i)}
          </button>
        ))}
        {entries.length === 0 && <span class="bullet-empty">No colors yet.</span>}
      </div>

      <SelectedColorBar
        entry={selectedEntry}
        label={selectedEntry ? codeOf(selectedEntry, selIdx) : ''}
        onEdit={onEdit}
      />

      <section class="scatter-pair">
        <Scatter
          title="Human — OKLab chroma"
          points={humanPts}
          xLabel="green ↔ red"
          yLabel="blue ↔ yellow"
          unit="a/b"
          onSelect={(i) => selectEntry(entries[i].id)}
          selected={selIdx}
          onBackgroundClick={() => setSelectedId(null)}
        />
        <Scatter
          title="Cat — RNL cone space (ΔS)"
          points={catPts}
          xLabel="yellow ↔ blue"
          yLabel="dark ↔ light"
          unit="ΔS"
          gamutBoundary={catGamut}
          onPick={onPickCat}
          onSelect={(i) => selectEntry(entries[i].id)}
          selected={selIdx}
          onBackgroundClick={() => setSelectedId(null)}
          marker={pick?.loc ?? null}
          shade={catShadeCb}
          dim={catDimCb}
          measure={nearestCat ? { to: { x: nearestCat.pt.x, y: nearestCat.pt.y }, belowMinSep: pickBelowMin } : null}
        >
          <div class="metamer-control">
            <label for="metamer-s">Cat-plot shading — metamer position</label>
            <div class="slider-row">
              <span>greener</span>
              <input
                id="metamer-s"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={metamerS}
                aria-label="Metamer position along each spot's red-green spread"
                onInput={(e) => setMetamerS(parseFloat((e.target as HTMLInputElement).value))}
              />
              <span>redder</span>
            </div>
          </div>
        </Scatter>
      </section>

      {entries.length > SOFT_CAP && (
        <div class="warn">
          Beyond ~{SOFT_CAP} lines, even normal vision struggles to tell colors apart — and a cat's single
          color axis makes it much harder. Consider line letters or dashes as a backup code.
        </div>
      )}

      <h2 class="palette-head">Palette</h2>
      <section class="palette">
        {entries.map((e, i) => (
          <EntryRow
            key={e.id}
            entry={e}
            index={i}
            bg={background}
            minContrast={minContrast}
            isWorst={i === wi || i === wj}
            onEdit={onEdit}
            onCode={onCode}
            onToggleLock={onToggleLock}
            onRemove={onRemove}
          />
        ))}
        {entries.length === 0 && <div class="empty">No colors yet — add a line.</div>}
      </section>

      {pick && (
        <MetamerPopup
          loc={pick.loc}
          screen={pick.screen}
          metamers={pick.metamers}
          dist={nearestCat?.d ?? null}
          belowMinSep={pickBelowMin}
          onClose={() => setPick(null)}
        />
      )}

      {loadOpen && (
        <div class="modal-overlay" onClick={() => setLoadOpen(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Load palette</h2>
            <p class="modal-hint">
              Paste hex colors (any separator) or a catsafe JSON export — or choose a file. This replaces the
              current palette.
            </p>
            <textarea
              class="load-textarea"
              spellcheck={false}
              value={loadText}
              placeholder={'#c1272d\n#0061a8\n#1f9e57\n…'}
              onInput={(e) => setLoadText((e.target as HTMLTextAreaElement).value)}
            />
            <div class="modal-row">
              <input type="file" accept=".json,.txt,application/json,text/plain" onChange={onLoadFile} />
            </div>
            {loadErr && <div class="modal-err">{loadErr}</div>}
            <div class="modal-actions">
              <button onClick={() => setLoadOpen(false)}>Cancel</button>
              <button class="primary" onClick={doLoad}>
                Load palette
              </button>
            </div>
          </div>
        </div>
      )}

      <footer>
        <p>
          Cat separation is measured in a receptor-noise (Vorobyev–Osorio) cone space: each color is mapped to
          the cat's two cones (human S≈450&nbsp;nm and L≈556&nbsp;nm fundamentals, M dropped), giving a 2-D plane
          of <em>luminance</em> (the cat's dominant channel) vs a single, noise-weighted <em>blue↔yellow</em>
          axis. The cat scatter <em>is</em> that metric — distance on the plot equals the computed ΔS (in JND).
          The cat <em>swatches</em>, separately, are a Machado&nbsp;(2009) deuteranope rendering for illustration.
          No validated cat-colorimetry model exists, so this is a principled approximation, not ground truth;
          cats also have low acuity, so favor bold lines and strong lightness contrast.
        </p>
      </footer>
    </div>
  );
}
