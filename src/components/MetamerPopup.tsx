import { useEffect, useRef, useState } from 'preact/hooks';
import { legibleTextOn, type Metamer, type XY } from '../color';

const W = 264; // popup width, also used to clamp it inside the viewport

/**
 * Floating card anchored at the cursor, listing the cat-metamer set of a clicked
 * RNL location: the human sRGB colors that all collapse to that one cat point.
 * Shows the single appearance a cat shares for the whole set, then each human
 * color as a click-to-copy swatch. Dismisses on Escape or an outside click.
 */
export function MetamerPopup({
  loc,
  screen,
  metamers,
  dist,
  belowMinSep,
  onClose,
}: {
  loc: XY;
  screen: { x: number; y: number };
  metamers: Metamer[];
  /** ΔS from the clicked spot to the nearest palette color (null if no colors). */
  dist: number | null;
  /** True when `dist` is below the palette's min separation — shown in red. */
  belowMinSep: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Outside-click close. On mousedown so a follow-up click on the plot can
    // re-pick (this closes, then the plot's own click opens the new spot).
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // The card is viewport-fixed but the crosshair it annotates scrolls with the
    // page, so dismiss rather than let them drift apart.
    const onScroll = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  // Move focus into the card on open and restore it on close, so keyboard/AT
  // users who opened a metamer set (via a focused dot) land in the dialog and
  // return to where they were afterwards. Runs once for the card's lifetime.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Representative shared appearance: the middle sample (most neutral metamer).
  const rep = metamers.length ? metamers[Math.floor(metamers.length / 2)] : null;

  // Place near the cursor, flipped/clamped to stay on screen.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  let left = screen.x + 14;
  if (left + W > vw - 8) left = Math.max(8, screen.x - W - 14);
  const top = Math.max(8, Math.min(screen.y + 14, vh - 8 - 320));

  const copy = (hex: string) => {
    navigator.clipboard?.writeText(hex);
    setCopied(hex);
    setTimeout(() => setCopied((c) => (c === hex ? null : c)), 900);
  };

  return (
    <div
      ref={ref}
      class="metamer-pop"
      role="dialog"
      aria-label="Colors at this cat location"
      tabIndex={-1}
      style={{ left: `${left}px`, top: `${top}px`, width: `${W}px` }}
    >
      <button class="metamer-close" onClick={onClose} aria-label="Close" title="Close">
        ✕
      </button>
      <div class="metamer-head">Cat sees one color here</div>
      <div class="metamer-loc">
        RNL ({loc.x.toFixed(1)}, {loc.y.toFixed(1)})
      </div>
      {dist != null && (
        <div class={`metamer-dist${belowMinSep ? ' below' : ''}`}>
          {dist < 1 ? dist.toFixed(3) : dist.toFixed(1)} ΔS to nearest color
        </div>
      )}

      {metamers.length === 0 ? (
        <div class="metamer-empty">
          No sRGB color lands on this exact spot — it's past the screen's gamut or too dark to resolve here.
          Try clicking nearer the dots.
        </div>
      ) : (
        <>
          {rep && (
            <div class="metamer-catrow">
              <div class="metamer-cat-sw" style={{ background: rep.cat }} />
              <div class="metamer-cat-txt">
                <span>≈ what a cat sees</span>
                <code>{rep.cat}</code>
              </div>
            </div>
          )}
          <div class="metamer-sub">
            {metamers.length === 1
              ? 'Only one sRGB color resolves here — click to copy'
              : `${metamers.length} human colors a cat can't tell apart — click to copy`}
          </div>
          <div class="metamer-grid">
            {metamers.map((m) => (
              <button
                key={m.hex}
                class="metamer-swatch"
                style={{ background: m.hex, color: legibleTextOn(m.hex) }}
                title={`Copy ${m.hex}`}
                onClick={() => copy(m.hex)}
              >
                {copied === m.hex ? '✓ copied' : m.hex}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
