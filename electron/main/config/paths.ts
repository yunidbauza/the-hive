import { homedir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_PATH_ENV } from '@shared/config-contract';

/**
 * Where the config lives, and how a failure to reach it is described.
 *
 * Extracted from `index.ts` (story 101) so that `write.ts` can locate the file
 * without importing the module that imports *it*. Both are two-line helpers
 * with no state; the split exists to keep the dependency arrow pointing one
 * way, not because either grew.
 */

/**
 * The hive folder's name under the home directory: `.hive`, or `.hive-dev`
 * for an unpackaged build (HIVE-227). A module setting rather than
 * `HIVE_CONFIG_PATH`, which every PTY session and agent run would inherit.
 */
let hiveDir = '.hive';

/** Called once, at boot, by an unpackaged build. `HIVE_CONFIG_PATH` still wins. */
export function switchToDevHiveDir(): void {
  hiveDir = '.hive-dev';
}

/**
 * Where the config lives.
 *
 * Read from the environment on every call rather than captured at module load:
 * story 085's Playwright fixture sets `HIVE_CONFIG_PATH` per test, and a
 * value frozen at import time would make the first spec to load this module
 * decide the path for all of them.
 */
export function configPath(): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), hiveDir, 'config.json');
}

export const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
