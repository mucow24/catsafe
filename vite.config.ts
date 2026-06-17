import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base './' keeps the built bundle path-relative so it works from any static host or subpath.
export default defineConfig({
  plugins: [preact()],
  base: './',
});
