import { homedir } from 'node:os';
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

/**
 * Claude Code's own configuration directory — **not** The Hive's.
 *
 * A third root, and the first one here that belongs to another application.
 * It is read, never written: an agent is a `claude -p` process, so the skills
 * and plugins the user installed for themselves are skills that process can
 * already reach, and `available.ts` needs to know their names to stop refusing
 * them.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own override and is honoured for the
 * reason `configPath()` honours `HIVE_CONFIG_PATH`: a spec that does not set it
 * reads the developer's real `~/.claude`, and its expectations then depend on
 * which plugins happened to be installed that week.
 *
 * `agents-settings.spec.ts` sets it per launch rather than the shared fixture
 * doing so for everyone: other specs in that project spawn a **real** `claude`,
 * and relocating that binary's own configuration directory is not something to
 * do to them in passing.
 */
export const claudeRoot = (): string =>
  process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');

/** The user's own skills, which The Hive lists but does not manage. */
export const userSkillsRoot = (): string => join(claudeRoot(), 'skills');

/**
 * Which plugins are installed, and where each one's active version lives.
 *
 * The registry rather than a glob over the cache: several versions of one
 * plugin can sit on disk at once, and only this file says which is current.
 */
export const installedPluginsFile = (): string =>
  join(claudeRoot(), 'plugins', 'installed_plugins.json');
