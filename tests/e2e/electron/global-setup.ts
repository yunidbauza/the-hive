import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FullConfig } from '@playwright/test';

/**
 * Builds the Electron app when `out/` is missing or stale (story 085).
 *
 * A README instruction saying "run `pnpm desktop:build` first" is a rule that
 * gets forgotten exactly once, and the failure is worse than forgetting: the
 * suite runs green against yesterday's binary, which is a false pass rather
 * than an error.
 */

const APP_ROOT = join(import.meta.dirname, '../../..');
const MAIN_ENTRY = join(APP_ROOT, 'out/main/index.js');

/**
 * Sources whose change should invalidate `out/`.
 *
 * **Every rollup input, not just the app's** (HIVE-100). The renderer target
 * names three HTML inputs — `index.html`, `splash.html`, `about.html` — and
 * only the first was listed here. Editing the splash therefore left `out/`
 * looking fresh, so `splash.spec.ts` went on asserting against the previously
 * built copy: the exact false pass the note above says this function exists to
 * prevent, reached by the one route it had not been pointed at.
 *
 * Found by changing the splash's kicker copy and watching the suite fail on the
 * *old* string. The rule to keep: if `electron.vite.config.ts` names it as an
 * input, it belongs in this list.
 */
const WATCHED = [
  'electron',
  'src',
  'index.html',
  'splash.html',
  'about.html',
  'electron.vite.config.ts',
];

/** Newest mtime under a path, following directories. */
function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    // `node_modules` is not ours and dwarfs everything else.
    if (entry.name === 'node_modules') continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

function isStale(): boolean {
  if (!existsSync(MAIN_ENTRY)) return true;
  const built = statSync(MAIN_ENTRY).mtimeMs;
  return WATCHED.some((rel) => newestMtime(join(APP_ROOT, rel)) > built);
}

/**
 * Will the Electron project actually run?
 *
 * `config.projects` lists every **configured** project, not the ones surviving
 * `--project` — so trusting it makes `pnpm test:e2e:web` build the desktop app
 * for nothing. The filter itself is only on the command line, so that is where
 * it has to be read from.
 */
function electronWillRun(config: FullConfig): boolean {
  const selected: string[] = [];
  for (const [index, argument] of process.argv.entries()) {
    if (argument === '--project') {
      const value = process.argv[index + 1];
      if (value) selected.push(value);
    } else if (argument.startsWith('--project=')) {
      selected.push(argument.slice('--project='.length));
    }
  }

  // No filter → every configured project runs.
  if (selected.length === 0) {
    return config.projects.some((project) => project.name === 'electron');
  }
  return selected.includes('electron');
}

export default function globalSetup(config: FullConfig): void {
  if (!electronWillRun(config)) return;
  if (!isStale()) return;

  // eslint-disable-next-line no-console
  console.log('[hive] out/ is missing or stale — running `pnpm desktop:build`…');
  execFileSync('pnpm', ['run', 'desktop:build'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
  });
}
