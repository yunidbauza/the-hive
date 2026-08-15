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
 * The one place the picker's own failure title is spelled out. `validate.ts`
 * owns the equivalent title for a file that *was* read but failed to parse
 * (`Couldn't import ${fileName}`) — this is that family's other member, for
 * a file the picker never managed to hand back at all.
 */
export const PICK_FAILURE_TITLE = "Couldn't import that file";

/**
 * What `pickThemeFile()` rejects with — never a bare `Error`, so a caller
 * (Task 11's gallery) can read `.title` and `.detail` straight into a banner
 * without re-deriving or re-prefixing either. Still an `Error` (not a plain
 * object) so `instanceof Error`, `.rejects.toThrow()` and ordinary crash
 * logging keep working on it unchanged; `.message` carries both parts
 * together for exactly that audience.
 */
export class PickThemeFailure extends Error {
  readonly title: string;
  readonly detail: string;

  constructor(detail: string, title: string = PICK_FAILURE_TITLE) {
    super(`${title} — ${detail}`);
    this.name = 'PickThemeFailure';
    this.title = title;
    this.detail = detail;
  }
}

/**
 * Everything Electron and main wrap around the sentence worth showing.
 *
 * `ipcRenderer.invoke` does not hand the renderer main's error — it hands back
 * a *new* one whose message quotes the channel and then the original, class
 * name and all:
 *
 * ```
 * Error invoking remote method 'theme:pick': IpcValidationError: theme:pick: /Users/me/themes/huge.json is 999999 bytes, over the 262144-byte limit
 * ```
 *
 * An anchored `/^theme:pick:/` therefore never matched in the running app, and
 * the banner showed the whole chain. Stripping up to the *last* channel prefix
 * takes both wrappers off in one pass, whatever Electron puts in front.
 */
const IPC_WRAPPERS = /^.*\btheme:pick:\s*/s;

/**
 * The directory the file came out of.
 *
 * Dropped deliberately, and the file's own name kept: `huge.json is 999999
 * bytes, over the 262144-byte limit` says everything the message has to say,
 * while `/Users/somebody/…` is a home directory in a settings banner — and in
 * any screenshot of one. The byte counts, which are the actual content, stay.
 */
const LEADING_DIRECTORY = /^\/\S*\//;

/**
 * `window.hive.theme.pick()` rejects rather than resolving `null` when the
 * chosen file is over the byte cap (`electron/main/theme/index.ts`) —
 * deliberately, so "too big" can never be confused with "cancelled". That
 * rejection is real, but its message is an implementation detail: see the two
 * patterns above for what comes off and why.
 */
function toPickFailure(error: unknown): PickThemeFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.replace(IPC_WRAPPERS, '').replace(LEADING_DIRECTORY, '');
  return new PickThemeFailure(detail);
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
 * How long after the window regains focus a still-empty input counts as a
 * dismissal.
 *
 * Long enough that a `change` on its way — it is dispatched after focus
 * returns, not before — always wins the race; short enough that the Import
 * button does not sit disabled while the user wonders what happened.
 */
const DISMISSAL_GRACE_MS = 400;

/**
 * The browser fallback: an `<input type="file">` with no `<form>`, added to
 * nothing — clicking it is enough to open the native picker in every engine
 * this app targets, and leaving it out of the document means there is no stray
 * node to clean up afterwards. `change` carries the chosen file; `cancel` fires
 * when the dialog closes with none chosen, matching the bridge's own
 * "cancelled ⇒ null" contract. `file.text()`'s rejection branch is handled
 * explicitly (not `void`-ed away) so a read failure becomes this promise's
 * rejection instead of an unhandled one.
 *
 * ## Why it does not rely on `cancel` alone
 *
 * `cancel` is comparatively recent and not universal. In an engine that never
 * fires it, dismissing the dialog settled this promise **never** — and since
 * `ThemeGallery` clears its `importing` flag in a `finally`, that left Import
 * disabled for the rest of the session, with two listeners and a live promise
 * held alive behind it. The window regaining focus with the input still empty
 * is the fallback signal; the grace period is what keeps it from beating a
 * `change` that is about to arrive.
 *
 * Everything is torn down through one `finish`, so whichever of the three
 * paths gets there first detaches every listener, cancels the timer, and makes
 * the other two inert.
 */
function pickThemeFileFromBrowser(): Promise<PickedThemeFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    const listeners = new AbortController();
    let dismissal: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void) => {
      listeners.abort();
      clearTimeout(dismissal);
      settle();
    };

    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        if (!file) {
          finish(() => resolve(null));
          return;
        }
        // The read is already holding `file`, so tearing the listeners down
        // first costs nothing and stops the dismissal timer from firing
        // underneath a file that is being read.
        finish(() => {
          file.text().then(
            (contents) => resolve({ name: file.name, contents }),
            (error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              reject(new PickThemeFailure(detail));
            },
          );
        });
      },
      { signal: listeners.signal },
    );

    input.addEventListener('cancel', () => finish(() => resolve(null)), {
      signal: listeners.signal,
    });

    window.addEventListener(
      'focus',
      () => {
        // Focus can return more than once (another window, a devtools panel);
        // only the most recent grace period may be pending.
        clearTimeout(dismissal);
        dismissal = setTimeout(() => {
          if ((input.files?.length ?? 0) === 0) finish(() => resolve(null));
        }, DISMISSAL_GRACE_MS);
      },
      { signal: listeners.signal },
    );

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
