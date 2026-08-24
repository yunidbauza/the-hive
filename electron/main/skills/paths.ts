import { dirname, join } from 'node:path';

import { configPath } from '../config/paths';

/**
 * Where the user's skills and the generated plugin live (HIVE-96).
 *
 * Two roots, and they are deliberately not the same place. `~/.hive/skills` is
 * the **user's** — hand-editable, backed up with their dotfiles, and the thing
 * Settings writes. `<userData>/hive/plugin` is the **app's** — regenerated from
 * the first, never edited by hand, and disposable. `hooks/settings.ts` draws the
 * same line for the same reason.
 */

/**
 * The skills tree, derived from the config file rather than from `homedir()`.
 *
 * `configPath()` honours `HIVE_CONFIG_PATH`, which story 085's Playwright
 * fixture sets per test. Deriving this from it means a test that relocates the
 * config relocates the skills with it; reaching for `homedir()` here would have
 * every e2e run write into the developer's own `~/.hive` — and the e2e step
 * this story adds creates a skill, so that would not stay theoretical.
 *
 * Read per call rather than captured, for the reason `configPath` itself gives:
 * a value frozen at import time lets the first spec to load this module decide
 * the path for all of them.
 */
export const skillsRoot = (): string => join(dirname(configPath()), 'skills');

/**
 * Where the generated plugin lives inside userData, beside the hook settings.
 *
 * A path *segment* rather than an absolute path, like `HOOK_SETTINGS_DIR` and
 * `METRICS_SCRIPT_FILE` next door: the absolute form needs `app.getPath`, which
 * only the process that has Electron can call, and keeping the constant
 * relative is what lets this module's tests run under plain Node.
 */
export const PLUGIN_DIR = join('hive', 'plugin');
