import { join } from 'node:path';

/**
 * Where the skills and agents the app ships are read from (HIVE-162).
 *
 * `resources/skills/<name>/` and `resources/agents/<name>/AGENT.md` in the
 * repository; `Contents/Resources/{skills,agents}/` in a packaged build, put
 * there by the `extraResources` block in `electron-builder.yml` the same way
 * `resources/tray` is. `app-icon.ts`'s `trayIconPath` draws the same line and
 * for the same reason: `out/main/` is where this module runs from in both
 * dev and packaged builds, so the repository copy is two levels up from it.
 *
 * `isPackaged` and `resourcesPath` are parameters rather than `app.isPackaged`
 * and `process.resourcesPath` so this module's tests run under plain Node,
 * the rule every `paths.ts` under `electron/main` already follows.
 */
export function shippedRoot(
  isPackaged: boolean,
  resourcesPath: string,
  dirname: string,
): string {
  return isPackaged ? resourcesPath : join(dirname, '../../resources');
}

/**
 * `~/.hive/.seed.json` — what the last seed wrote, per file.
 *
 * A dotfile beside `config.json`, in `~/.hive` rather than userData: it
 * records a fact about files that live in `~/.hive`, and a person who copies
 * that folder to a new machine should carry the record with it, or every
 * shipped file they had left untouched would look hand-edited there.
 */
export const SEED_MANIFEST_FILE = '.seed.json';
