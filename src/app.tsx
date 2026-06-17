import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { catHex, contrastRatio, labelColor, paletteScore, simulate, type Sim } from './color';
import { optimizePalette } from './optimize';
import { Scatter } from './components/Scatter';
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

/** Parse a pasted palette: a catsafe JSON export, a JSON array, or loose hex tokens. */
function parsePalette(text: string): Array<{ color: string; locked: boolean }> {
  const t = text.trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) {
      const out: Array<{ color: string; locked: boolean }> = [];
      for (const x of j) {
        if (typeof x === 'string') {
          const h = normHex(x);
          if (h) out.push({ color: h, locked: false });
        } else if (x && typeof x === 'object') {
          const h = normHex(String(x.human ?? x.color ?? x.hex ?? ''));
          if (h) out.push({ color: h, locked: !!x.locked });
        }
      }
      if (out.length) return out;
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
  return out;
}

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

const mk = (color: string, locked = false, edited = false): Entry => ({ id: uid(), color, locked, edited });

const DEFAULT_STATE: State = {
  entries: [mk('#c1272d'), mk('#0061a8'), mk('#1f9e57'), mk('#e58a00'), mk('#6a3d9a')],
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
function loadInitial(): State {
  if (location.hash.startsWith('#p=')) {
    const s = decode(location.hash.slice(3));
    if (s) return s;
  }
  try {
    const raw = localStorage.getItem('catsafe');
    if (raw) {
      const s = decode(raw);
      if (s) return s;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_STATE;
}

// --- per-entry row -----------------------------------------------------------

function EntryRow(props: {
  entry: Entry;
  index: number;
  bg: string;
  minContrast: number;
  isWorst: boolean;
  onEdit: (id: string, color: string, coalesceKey?: string) => void;
  onToggleLock: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { entry, index, bg, minContrast, isWorst, onEdit, onToggleLock, onRemove } = props;
  const cat = catHex(entry.color);
  const cr = contrastRatio(entry.color, bg);
  const lowContrast = cr < minContrast;
  const [copied, setCopied] = useState(false);
  const copyHex = () => {
    navigator.clipboard?.writeText(entry.color);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  const lockLabel = entry.locked ? (entry.edited ? '✎' : '🔒') : '🔓';
  const lockTitle = entry.locked
    ? entry.edited
      ? 'Edited & locked — click to release to the optimizer'
      : 'Locked — click to unlock'
    : 'Unlocked — click to lock';

  return (
    <div class={`row${isWorst ? ' worst' : ''}${entry.locked ? ' locked' : ''}`}>
      <div class="line-no">{index + 1}</div>

      <div class="swatches">
        <div class="swatch" style={{ background: entry.color, color: labelColor(entry.color) }}>
          <span class="sw-label">human</span>
          <span class="sw-hex">{entry.color}</span>
        </div>
        <div class="swatch" style={{ background: cat, color: labelColor(cat) }}>
          <span class="sw-label">cat</span>
          <span class="sw-hex">{cat}</span>
        </div>
      </div>

      <div class="row-controls">
        <input
          type="color"
          value={entry.color}
          aria-label={`Line ${index + 1} color`}
          onInput={(e) => onEdit(entry.id, (e.target as HTMLInputElement).value, `pick:${entry.id}`)}
        />
        <input
          class="hex-input"
          type="text"
          spellcheck={false}
          value={entry.color}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (/^#?[0-9a-fA-F]{6}$/.test(v)) onEdit(entry.id, v.startsWith('#') ? v : '#' + v);
          }}
        />
        <button
          class={`copy-hex${copied ? ' done' : ''}`}
          title={copied ? 'Copied!' : 'Copy hex'}
          aria-label="Copy hex code"
          onClick={copyHex}
        >
          {copied ? '✓' : '⧉'}
        </button>
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
  const state = hist.present;
  const { entries, catWeight, background, minContrast } = state;
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
        entries: s.entries.map((e) => (e.id === id ? { ...e, color, edited: true, locked: true } : e)),
      }),
      coalesceKey,
    );

  const onToggleLock = (id: string) =>
    setEntries((es) =>
      es.map((e) =>
        e.id === id ? (e.locked ? { ...e, locked: false, edited: false } : { ...e, locked: true }) : e,
      ),
    );

  const onRemove = (id: string) => setEntries((es) => es.filter((e) => e.id !== id));
  const onAdd = () => setEntries((es) => (es.length >= MAX_ENTRIES ? es : [...es, mk('#777777')]));

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
        const next = s.entries.map((e) => (e.locked ? e : { ...e, color: colors[k++] ?? e.color, edited: false }));
        return { ...s, entries: next };
      });
      setBusy(false);
    }, 10);
  };

  // exports
  const copy = (text: string) => navigator.clipboard?.writeText(text);
  const exportHex = () => copy(entries.map((e) => e.color).join('\n'));
  const exportCss = () => copy(entries.map((e, i) => `  --line-${i + 1}: ${e.color};`).join('\n'));
  const exportJson = () => {
    const data = JSON.stringify(
      entries.map((e, i) => ({ line: i + 1, human: e.color, cat: catHex(e.color), locked: e.locked })),
      null,
      2,
    );
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'catsafe-palette.json';
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
    if (parsed.length === 0) {
      setLoadErr('No colors found. Paste hex values (e.g. #1a2b3c) or a catsafe JSON export.');
      return;
    }
    const next = parsed.slice(0, MAX_ENTRIES).map((p) => mk(p.color, p.locked, false));
    apply((s) => ({ ...s, entries: next }));
    setLoadOpen(false);
  };

  const humanPts = sims.map((s, i) => ({ x: s.human.a, y: s.human.b, fill: s.hex, hex: s.hex, label: String(i + 1) }));
  const catPts = sims.map((s, i) => ({ x: s.catXY.x, y: s.catXY.y, fill: s.catHex, hex: s.catHex, label: String(i + 1) }));

  return (
    <div class="app">
      <header>
        <h1>🐈‍⬛ catsafe</h1>
        <p class="tagline">
          Transit-line color palettes that stay distinct for humans <em>and</em> cats.
        </p>
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
            {wi >= 0 ? `worst pair: lines ${wi + 1} & ${wj + 1}` : 'add 2+ colors'}
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
        />
      </section>

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
