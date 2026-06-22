import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  catGamutBoundary,
  catHex,
  catMetamers,
  contrastRatio,
  hexToHsl,
  hslToHex,
  isLightBackground,
  labelColor,
  paletteScore,
  simulate,
  type Hsl,
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
          style={{ background: entry.color, color: labelColor(entry.color) }}
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
          style={{ background: cat, color: labelColor(cat) }}
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
  const state = hist.present;
  const { entries, catWeight, background, minContrast } = state;
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

  // Mirror the map background under test onto the whole page. When it's light
  // (e.g. white), flip the UI chrome to a light surface so palette colors are
  // judged in the same context a real map gives them — a dark page would skew
  // how the colors read. useLayoutEffect avoids a dark→light flash on load
  // (the default background is white).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--page-bg', background);
    root.classList.toggle('light-map', isLightBackground(background));
  }, [background]);

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
  const score = useMemo(() => paletteScore(sims, catWeight), [sims, catWeight]);
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
          catWeight: s.catWeight,
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

  return (
    <div class="app">
      <header>
        <h1>🐈‍⬛ catsafe</h1>
        <p class="tagline">
          Transit-line color palettes that stay distinct for humans <em>and</em> cats.
        </p>
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
      </header>

      <section class="controls">
        <div class="control slider-control">
          <label>Optimize for</label>
          <div class="slider-row">
            <span>Human</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={catWeight}
              onInput={(e) => update({ catWeight: parseFloat((e.target as HTMLInputElement).value) }, 'slider:w')}
            />
            <span>Cat</span>
          </div>
          <div class="slider-val">
            {Math.round((1 - catWeight) * 100)}% human · {Math.round(catWeight * 100)}% cat
          </div>
        </div>

        <div class="control">
          <label>Map background</label>
          <div class="bg-row">
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
          </div>
        </div>

        <div class="control">
          <label>Min contrast: {minContrast.toFixed(1)}:1</label>
          <input
            type="range"
            min="1"
            max="7"
            step="0.5"
            value={minContrast}
            onInput={(e) => update({ minContrast: parseFloat((e.target as HTMLInputElement).value) }, 'slider:contrast')}
          />
        </div>

        <div class="control score-control">
          <label>Min separation (ΔS, JND)</label>
          <div class="score">{score.min === Infinity ? '—' : score.min.toFixed(1)}</div>
          <div class="score-sub">
            {wi >= 0 ? `worst pair: lines ${codeOf(entries[wi], wi)} & ${codeOf(entries[wj], wj)}` : 'add 2+ colors'}
          </div>
        </div>

        <div class="control actions">
          <button class="primary" disabled={busy} onClick={recompute}>
            {busy ? 'Computing…' : '↻ Recompute'}
          </button>
          <button onClick={onAdd} disabled={entries.length >= MAX_ENTRIES}>
            + Add line
          </button>
        </div>

        <div class="control exports">
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

        <div class="control">
          <label>History</label>
          <div class="export-row">
            <button class="mini" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
              ↶ undo
            </button>
            <button class="mini" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
              ↷ redo
            </button>
          </div>
        </div>
      </section>

      {entries.length > SOFT_CAP && (
        <div class="warn">
          Beyond ~{SOFT_CAP} lines, even normal vision struggles to tell colors apart — and a cat's single
          color axis makes it much harder. Consider line letters or dashes as a backup code.
        </div>
      )}

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

      <section class="scatter-pair">
        <Scatter
          title="Human — OKLab chroma"
          points={humanPts}
          xLabel="green ↔ red"
          yLabel="blue ↔ yellow"
          unit="a/b"
        />
        <Scatter
          title="Cat — RNL cone space (ΔS)"
          points={catPts}
          xLabel="yellow ↔ blue"
          yLabel="dark ↔ light"
          unit="ΔS"
          gamutBoundary={catGamut}
          note="Hatched: cone-space no human-visible (sRGB) color can reach"
          onPick={onPickCat}
          marker={pick?.loc ?? null}
          measure={nearestCat ? { to: { x: nearestCat.pt.x, y: nearestCat.pt.y }, belowMinSep: pickBelowMin } : null}
          hint="Click a spot — or tab to a line — to see the colors a cat sees there"
        />
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
