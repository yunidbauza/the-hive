import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { aliases } from './vite.aliases.mjs';

/**
 * The BROWSER target (story 083): a fixtures-only demo surface.
 *
 * Electron is the product; this build survives because the transport seam makes
 * it a branch on one factory, and it keeps the six Playwright web specs and a
 * no-install demo alive. `pnpm dev` and `pnpm build` still mean exactly what
 * they meant before Electron existed — see `electron.vite.config.ts` for the
 * desktop targets.
 *
 * Aliases come from `vite.aliases.mjs` so this config and the Electron one
 * cannot drift (story 080).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
});
