/**
 * Getting a theme file on and off disk, from the renderer, in either target
 * (HIVE-80).
 *
 * `src/components/terminal/` and `src/components/editor/` are not the only
 * seam in this codebase that has to work with and without a bridge — Task 7
 * wired `window.hive.theme` for Electron, but the Appearance section renders
 * under `pnpm dev` too, where there is no bridge at all. `chooseProjectDirectory`
 * (`src/lib/project-config.ts:365-375`) resolves `null` in both the
 * cancelled-dialog case and the no-bridge case, because a browser build has no
 * filesystem to offer. That rule does not fit here: a settings group that
 * silently does nothing in the browser target is exactly the kind of invisible
 * degradation `isDesktop()`'s own doc comment (`src/config/runtime.ts`) warns
 * against. So the browser target gets a **real** implementation instead of a
 * `null` — `<input type="file">` to pick, a `Blob` + object URL + synthetic
 * `<a download>` to save.
 */

const bridge = () => window.hive?.theme ?? null;

/** What `pickThemeFile` resolves on success — the file's name, not its path. */
export interface PickedThemeFile {
  name: string;
  contents: string;
}

/**
 * `window.hive.theme.pick()` rejects rather than resolving `null` when the
 * chosen file is over the byte cap (`electron/main/theme/index.ts`) —
 * deliberately, so "too big" can never be confused with "cancelled". That
 * rejection is real, but its message is an implementation detail: it starts
 * with the IPC channel name and carries the file's absolute path, neither of
 * which belongs in a settings banner. This turns it into a message fit to
 * show a person, without discarding the information (the byte counts stay).
 */
function toPickFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.replace(/^theme:pick:\s*/, '');
  return new Error(`Couldn't import that file — ${detail}`);
}

function fileNameFromPath(path: string): string {
  return path.split('/').pop() ?? 'theme.json';
}

/**
 * Resolve the picked file (its name and contents), `null` if the dialog was
 * cancelled, or **reject** if main refused to read it (currently: over the
 * byte cap). A rejection is deliberately never collapsed into `null` — the
 * caller (Task 11's gallery) can tell "the user picked nothing" from "the
 * user picked something we couldn't read" and render each as what it is.
 */
export async function pickThemeFile(): Promise<PickedThemeFile | null> {
  const desktop = bridge();
  if (desktop) {
    const picked = await desktop.pick().catch((error: unknown) => {
      throw toPickFailure(error);
    });
    return picked
      ? { name: fileNameFromPath(picked.path), contents: picked.contents }
      : null;
  }

  return pickThemeFileFromBrowser();
}

/**
 * The browser fallback: an `<input type="file">` with no `<form>`, added to
 * nothing — clicking it is enough to open the native picker in every engine
 * this app targets. `change` carries the chosen file; `cancel` fires when the
 * dialog closes with none chosen, matching the bridge's own "cancelled ⇒
 * null" contract. `file.text()`'s rejection branch is handled explicitly
 * (not `void`-ed away) so a read failure becomes this promise's rejection
 * instead of an unhandled one.
 */
function pickThemeFileFromBrowser(): Promise<PickedThemeFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(
        (contents) => resolve({ name: file.name, contents }),
        (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const VALID_FILE_NAME = /^[\w.-]{1,64}\.json$/;
const MAX_STEM_LENGTH = 64;
const FALLBACK_STEM = 'theme';

/**
 * Turn any theme name into a filename main's `/^[\w.-]{1,64}\.json$/`
 * (`electron/main/theme/index.ts`) will accept.
 *
 * `\w` is ASCII-only, so a theme named "Café" or "日本語" produces a
 * `suggestedName` main refuses outright — Export would throw for those
 * users with no path to a fix. Latin diacritics are transliterated first
 * (café → cafe) via Unicode NFKD normalisation, which decomposes the accent
 * into a separate combining mark that then gets stripped; anything still
 * outside `[\w.-]` afterwards — CJK, emoji, punctuation, spaces — becomes a
 * hyphen, runs of hyphens collapse to one, and leading/trailing separators
 * are trimmed. A name that sanitises to nothing ("日本語", "!!!", an
 * all-emoji title) falls back to a fixed stem rather than producing an
 * empty one, which the pattern would refuse just as surely as the
 * disallowed characters would have.
 */
export function sanitizeFileName(suggestedName: string): string {
  if (VALID_FILE_NAME.test(suggestedName)) return suggestedName;

  const stem = suggestedName.replace(/\.json$/i, '');
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  const stemToUse = cleaned.length > 0 ? cleaned : FALLBACK_STEM;
  const truncated = stemToUse.slice(0, MAX_STEM_LENGTH).replace(/[-.]+$/, '');

  return `${truncated.length > 0 ? truncated : FALLBACK_STEM}.json`;
}

/**
 * Write `contents` under `suggestedName`, sanitised so main's pattern always
 * accepts it. The desktop bridge opens a native save dialog and returns the
 * path written, or `null` if cancelled; the browser target has no dialog to
 * cancel, so it always downloads and resolves `true`.
 */
export async function saveThemeFile(
  suggestedName: string,
  contents: string,
): Promise<boolean> {
  const safeName = sanitizeFileName(suggestedName);
  const desktop = bridge();
  if (desktop) {
    const path = await desktop.save({ suggestedName: safeName, contents });
    return path !== null;
  }

  return saveThemeFileInBrowser(safeName, contents);
}

function saveThemeFileInBrowser(name: string, contents: string): boolean {
  const url = URL.createObjectURL(
    new Blob([contents], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  return true;
}
