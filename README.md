# 🐈‍⬛ catsafe

A small browser tool for building **transit-line color palettes that stay perceptually distinct for both humans and cats.**

Cats are dichromats — their color confusion structure matches a human red-green colorblind viewer (behavioral neutral point ~505 nm; cones at ~450 & ~556 nm). catsafe simulates cat vision and optimizes a palette so the colors stay far apart in *both* a human and a (simulated) cat perceptual field at once.

## Features

- **Add / remove** palette entries, one color each.
- **Lock** a color so recompute never touches it (🔒). Manually editing a color via the swatch picker or a hex field locks the row too; unlock to release it back to the optimizer.
- **Recompute** all unlocked entries to maximize perceptual separation, with locked colors held as fixed anchors.
- **Human ↔ Cat slider** — biases the optimizer. At the cat end it uses a worst-case objective: `(1−w)·d_human + w·min(d_human, d_cat)`, so a big human gap can't paper over a collapsed cat gap.
- **Dual swatches** per entry — the human color and the simulated cat color side by side.
- **Map mode** — a hard WCAG contrast filter against a settable background (default white), with auto black/white labels.
- **Live separation score** + worst-pair highlight.
- **OKLab a/b scatter plots** (human vs cat) so you can *see* which colors collapse for a cat.
- **Persistence & sharing** — autosaves to `localStorage` and encodes full state in the URL hash; export as hex / CSS variables / JSON.

## Run

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build to dist/
```

## How the cat simulation works (and its limits)

There is no validated colorimetric model of cat vision, so catsafe approximates it: apply the **Machado et al. (2009) deuteranopia** transform (severity 1.0, in linear RGB), then reduce chroma (cats' color signal is much weaker than a human deuteranope's) while preserving lightness (a cat's strongest channel). The underlying *biology* is well established; the **RGB transform is a borrowed approximation** — treat the cat swatches as a good guide, not ground truth.

## Color pipeline

- Conversions, OKLab/OKLCh, contrast, and gamut clamping via [culori](https://culorijs.org).
- Separation measured as Euclidean distance in OKLab.
- Optimization: greedy farthest-point seeding (Gonzalez 1985) + simulated-annealing polish, multi-restart, with locked colors as immovable seeds.
