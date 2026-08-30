import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

import { aliases } from './vite.aliases.mjs';

/**
 * The DESKTOP target (story 080) — three builds from one config.
 *
 * `src/` is not touched by any of this. The renderer target points at the same
 * `index.html` the browser build uses, which is the entire point: the app we
 * already shipped becomes the desktop app's UI rather than a thing we port.
 *
 * Output lands in `out/{main,preload,renderer}/`; `package.json`'s `main` field
 * points at `out/main/index.js`.
 */
export default defineConfig({
  main: {
    /**
     * Load-bearing on main and preload: it leaves `dependencies` unbundled.
     * Bundling a native module is not a thing that works, and `node-pty`
     * arrives in story 092.
     */
    plugins: [externalizeDepsPlugin()],
    /**
     * Extra inputs, not extra targets (stories 091 and 098).
     *
     * The story calls the pty host "a third main-process-style target".
     * `electron-vite`'s `defineConfig` has exactly three keys — `main`,
     * `preload`, `renderer` — and no fourth, so the same outcome is expressed
     * as a second rollup input on the `main` target. That is strictly better
     * than a separate build: the host inherits main's module format, its
     * `externalizeDepsPlugin` (so `node-pty` stays unbundled in story 092),
     * and its output directory, which is how `import.meta.dirname` can find
     * `pty-host.js` next to `index.js`.
     */
    build: {
      rollupOptions: {
        input: {
          index: 'electron/main/index.ts',
          'pty-host': 'electron/pty-host/index.ts',
          /**
           * A third input, for the conformance suite (story 098).
           *
           * Not an entry point anything *runs* — it is the session manager
           * emitted as an importable ESM module, so
           * `scripts/run-pty-conformance.mjs` can drive **the real thing**
           * under `ELECTRON_RUN_AS_NODE=1 electron`. A suite that talked to its
           * own pty wrapper would prove that wrapper works and nothing about
           * the product.
           *
           * It has to come through this build rather than be imported from
           * source: the file is TypeScript, it resolves `@shared/*`, and its
           * `node-pty` is built for Electron's ABI (story 084). This target
           * already solves all three — `externalizeDepsPlugin` keeps `node-pty`
           * unbundled, and rollup hoists what this shares with `pty-host` into
           * the chunk they both import.
           */
          'session-manager': 'electron/pty-host/session-manager.ts',
          /**
           * A fourth input: the MCP server every session is given (HIVE-112).
           *
           * On the `main` target rather than a target of its own for the reason
           * the pty host is: `defineConfig` takes `main`, `preload` and
           * `renderer` and no fourth. It emits `out/main/mcp-host.js`, beside
           * `index.js`, which is what lets main resolve the path it writes into
           * the generated config with `import.meta.dirname`.
           *
           * It has no `dependencies` — `externalizeDepsPlugin` has nothing to
           * externalise here — but it is not self-contained: it imports
           * `@shared/*`, and rollup emits that as its own
           * `out/main/chunks/mcp-contract-*.js`, alongside `mcp-host.js`
           * rather than inlined into it. It still needs no `asarUnpack` entry,
           * because that chunk ships inside `out/` like every other build
           * output and is read through Electron's asar-aware `fs`, the same
           * as `index.js` reading its own chunks.
           */
          'mcp-host': 'electron/mcp-host/index.ts',
        },
      },
    },
    resolve: { alias: aliases },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'electron/preload/index.ts',
        /**
         * CJS, explicitly, and with a `.cjs` extension.
         *
         * This package is `"type": "module"`, so a `.js` emit here would be
         * ESM — and a **sandboxed preload script cannot be ESM**. Electron
         * loads it with a CommonJS loader, so an `import` statement fails at
         * load time with an error that names neither `sandbox` nor ESM. The
         * security posture (story 082) is non-negotiable, so the module format
         * is what gives way.
         *
         * `electron/main/index.ts` points at `../preload/index.cjs` to match.
         */
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { alias: aliases },
  },
  renderer: {
    root: '.',
    /**
     * Relative asset URLs, because a built Electron app is loaded with
     * `loadFile` and its document origin is `file://`.
     *
     * Vite's default `base: '/'` emits root-relative URLs, and under `file://`
     * the root is the *filesystem* root — `/hive-tile.png` resolves to
     * `file:///hive-tile.png` and 404s silently as a broken image. The browser
     * target keeps `base: '/'` and is unaffected.
     */
    base: './',
    /**
     * Tailwind stays scoped to the renderer. Running the PostCSS pipeline over
     * the main or preload target would be meaningless work at best.
     */
    plugins: [react(), tailwindcss()],
    resolve: { alias: aliases },
    /**
     * Three documents, not three targets — the same move `main` makes for the
     * pty host, and for the same reason: `splash.html` and `about.html` need
     * this target's plugins, its aliases, its `base: './'` and its output
     * directory, and get all four by being another input rather than another
     * config.
     *
     * The splash shares no code with the app. Rollup will still hoist anything
     * they both import into a common chunk, which is exactly why `splash.ts`
     * imports nothing from `src/` outside its own directory: a shared chunk
     * between the two would put the app's module graph in front of the very
     * window that exists to cover the app's loading time.
     *
     * **`about.html` is deliberately not held to that rule**, and the
     * difference is timing rather than taste. The splash must paint before the
     * app's bundle exists; the About panel opens on demand, long after it does,
     * so a chunk it shares with the app costs nothing. That is what lets it
     * reuse the splash's creature and the app's phrase pools instead of
     * carrying a second copy of either.
     */
    build: {
      rollupOptions: {
        input: {
          index: 'index.html',
          splash: 'splash.html',
          about: 'about.html',
        },
      },
    },
  },
});
