import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Use relative asset URLs ('./') for production builds so the same dist/ works
// regardless of the path it's served under:
//   - GitHub Pages publishes this repo at https://mucow24.github.io/catsafe/
//     (served from the /catsafe/ subpath), and
//   - a local static server serves dist/ at the root.
// A relative base resolves correctly in both; an absolute '/catsafe/' base
// 404s the assets when the site is served from root. The app has no client-side
// router, so no nested route can shift the document base and break the relative
// paths. The dev server keeps Vite's default absolute '/' base — `mode` is
// 'development' there and 'production' for both `vite build` and `vite preview`.
export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  base: mode === 'production' ? './' : '/',
}));
