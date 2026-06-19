export interface Entry {
  id: string;
  /** Two-char service code shown in place of a line number (e.g. "A", "Q", "AA"). User-editable. */
  code: string;
  /** sRGB hex, e.g. "#3366cc" — the human-facing color. */
  color: string;
  /** Frozen from recompute. Single source of truth for "is this an anchor?". */
  locked: boolean;
  /** User manually typed this value. Implies locked (edit = permanent lock); badge only. */
  edited: boolean;
}

export interface State {
  /** User-given palette name; embedded in exports. */
  name: string;
  entries: Entry[];
  /** 0 = optimize purely for humans, 1 = purely for cats. */
  catWeight: number;
  /** Map background hex, used for the WCAG contrast filter. */
  background: string;
  /** Minimum WCAG contrast ratio every color must clear against the background. */
  minContrast: number;
}
