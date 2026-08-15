import { Buffer } from 'node:buffer';
import { readFile, stat, writeFile } from 'node:fs/promises';

import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';

import { IpcValidationError } from '@shared/guards';
import { MAX_THEME_BYTES } from '@shared/theme-contract';
import type { PickedTheme, SaveThemeRequest } from '@shared/theme-contract';

/**
 * Getting a theme file on and off disk (HIVE-80).
 *
 * Two verbs, and neither takes a destination path from the renderer — a
 * native dialog chooses it in both directions, which is what keeps the
 * epic's "no verb takes a destination path" rule true by construction rather
 * than by a check that could be forgotten (see `ipc/index.ts` around
 * `configReveal`/`configReset` for the same argument made about story 107).
 *
 * The window is resolved from the invoking event on every call rather than
 * captured once: there is no `mainWindow` singleton in this process — on
 * macOS the window can be closed and re-created while the app keeps running,
 * so a held reference would go stale. `chooseDirectory` resolves the same way
 * for the same reason.
 */

const THEME_FILE_FILTERS = [{ name: 'Hive theme', extensions: ['json'] }];

/**
 * `theme:pick` — a native open dialog filtered to `.json`, then a read.
 *
 * Resolves `null` for both a cancelled dialog and a window that no longer
 * exists by the time the dialog would have opened; the renderer treats the
 * two identically, so there is nothing to distinguish them for.
 *
 * An oversize file is **not** one of those `null` cases — see the size check
 * below.
 */
export async function pickTheme(
  event: IpcMainInvokeEvent,
): Promise<PickedTheme | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return null;

  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: THEME_FILE_FILTERS,
  });
  if (result.canceled) return null;

  const path = result.filePaths[0];
  if (path === undefined) return null;

  /**
   * Sized before it is read — the same order `readFileContent` uses
   * (`electron/main/fs/read.ts`), and for the same reason: `readFile` would
   * otherwise buffer the whole file in the main process, and then push all of
   * it across IPC, before anything got a chance to say no. The dialog already
   * proves this path came from the user and not the renderer, so this is not
   * a containment check the way `fs/read.ts`'s is — it is the same "do not
   * stall or OOM the process on a file nobody meant to open this way" guard,
   * reusing the cap the theme importer already carries.
   *
   * Thrown rather than resolved as `null`: cancelling the dialog and picking
   * a file main then refuses are different facts, and collapsing both into
   * `null` would have the picker report a cancellation for a file the user
   * genuinely chose. `readFile` below can already reject this same promise —
   * an unreadable path throws today — so a throw here is the existing failure
   * mode for this verb, just reached one syscall earlier.
   */
  const stats = await stat(path);
  if (stats.size > MAX_THEME_BYTES) {
    throw new IpcValidationError(
      `theme:pick: ${path} is ${stats.size} bytes, over the ${MAX_THEME_BYTES}-byte limit`,
    );
  }

  const contents = await readFile(path, 'utf8');
  return { path, contents };
}

/**
 * `theme:save` — a native save dialog, then a write.
 *
 * `defaultPath` only *suggests* the name; the dialog lets the user change it,
 * and the value that comes back in `result.filePath` is whatever the user
 * actually chose to write to — never the renderer's `suggestedName` used
 * directly as a destination.
 */
export async function saveTheme(
  event: IpcMainInvokeEvent,
  request: SaveThemeRequest,
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return null;

  const result = await dialog.showSaveDialog(window, {
    defaultPath: request.suggestedName,
    filters: THEME_FILE_FILTERS,
  });
  if (result.canceled || !result.filePath) return null;

  await writeFile(result.filePath, request.contents, 'utf8');
  return result.filePath;
}

/**
 * `ALLOWED_KEYS` is the gate: anything not in it is rejected, full stop.
 *
 * `FORBIDDEN_KEYS` is **not** a second gate, and it would be easy to read it as
 * one. Every name in it is already absent from `ALLOWED_KEYS`, so the branch it
 * drives changes only which sentence comes back — "forbidden key" rather than
 * "unexpected key" — for the handful of names that would be alarming to see
 * arrive. It is a message refinement, kept because a log line saying
 * `theme:save: forbidden key "__proto__"` is worth more to whoever reads it
 * than the generic one; deleting it would not weaken the check by one payload.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_KEYS = new Set(['suggestedName', 'contents']);

/** `x.json`, `my-theme_2.json` — never a path, never empty, bounded to 64 chars. */
const SUGGESTED_NAME_PATTERN = /^[\w.-]{1,64}\.json$/;

/**
 * Payload guard for `theme:save`.
 *
 * Both fields reach the filesystem — `contents` is written verbatim, and
 * `suggestedName` seeds the save dialog's default path — so neither may pass
 * unchecked. `contents` is bounded the same way `importTheme` bounds a file
 * read back in (`src/lib/theme/validate.ts`), against the one definition of
 * the cap in `@shared/theme-contract` — and in **bytes**, which is the unit the
 * cap is named in. `String.length` counts UTF-16 code units, so measuring with
 * it admitted up to four times the cap in non-ASCII text and wrote a file this
 * app's own `pickTheme` would then refuse to read back.
 * `suggestedName` is not a path: it is
 * never resolved or joined against a directory, only handed to
 * `dialog.showSaveDialog` as a suggestion the user can overwrite — but a
 * renderer that is compromised is still not free to hand the OS dialog
 * arbitrary text, so it is pattern-matched to a bare filename.
 */
export function parseSaveThemeRequest(input: unknown): SaveThemeRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new IpcValidationError(
      `theme:save: expected an object, got ${describe(input)}`,
    );
  }

  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new IpcValidationError(`theme:save: forbidden key "${key}"`);
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new IpcValidationError(`theme:save: unexpected key "${key}"`);
    }
  }

  const { contents, suggestedName } = raw;

  if (typeof contents !== 'string') {
    throw new IpcValidationError(
      `theme:save.contents: expected a string, got ${describe(contents)}`,
    );
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_THEME_BYTES) {
    throw new IpcValidationError(
      `theme:save.contents: exceeds the ${MAX_THEME_BYTES}-byte limit`,
    );
  }

  if (
    typeof suggestedName !== 'string' ||
    !SUGGESTED_NAME_PATTERN.test(suggestedName)
  ) {
    throw new IpcValidationError(
      'theme:save.suggestedName: must be a bare .json filename',
    );
  }

  return { contents, suggestedName };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
