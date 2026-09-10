/**
 * Getting a theme file on and off disk, from the renderer (HIVE-80, HIVE-146).
 *
 * ## Why this never asks main
 *
 * It used to, whenever a bridge existed, and fall back to `<input type="file">`
 * and a `Blob` download only in the `pnpm dev` browser target where there is no
 * bridge at all. HIVE-146 deleted that branch along with `theme:pick` and
 * `theme:save` themselves.
 *
 * The reason is that "is there a bridge" was never the question worth branching
 * on. A theme file lives on the machine the user is sitting at, and main is not
 * reliably that machine: while attached to a server, `dialog.showOpenDialog`
 * runs on the mini, which has no window to parent it and no copy of the file
 * the user meant. So the dialog was refused there (`WINDOW_BOUND`) and the
 * Import and Export buttons rendered disabled.
 *
 * The renderer, by contrast, is *always* on the right machine, in both modes.
 * So the browser implementation is the only correct one, and it is now the only
 * one. The theme it produces is applied to this window alone — `applyThemeColors`
 * injects a `<style>` element and `appearance-store` persists to `localStorage`,
 * neither of which crosses IPC — which is what the acceptance asks for, by
 * construction rather than by a check.
 */

import { MAX_THEME_BYTES } from '@lib/theme/contract';

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
 * Resolve the picked file (its name and contents), `null` if the picker was
 * dismissed, or **reject** if the file could not be read (over the byte cap,
 * or an unreadable file). A rejection is deliberately never collapsed into
 * `null` — the gallery can tell "the user picked nothing" from "the user
 * picked something we couldn't read" and render each as what it is.
 */
export async function pickThemeFile(): Promise<PickedThemeFile | null> {
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
 * An `<input type="file">` with no `<form>`, added to
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
        /**
         * Sized before it is read, which is the order the deleted `electron/main/theme/`
         * used to check in and the reason its check is not simply gone.
         * `importTheme` (`validate.ts`) caps the contents too, but only once
         * the whole file is in memory; refusing here costs one property read
         * and keeps a file nobody meant to open out of the heap.
         */
        if (file.size > MAX_THEME_BYTES) {
          finish(() =>
            reject(
              new PickThemeFailure(
                `${file.name} is ${file.size} bytes, over the ${MAX_THEME_BYTES}-byte limit`,
              ),
            ),
          );
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
 * Turn any theme name into a sane download filename.
 *
 * The pattern was once main's, enforced by `electron/main/theme/index.ts`,
 * which refused a `suggestedName` outside `/^[\w.-]{1,64}\.json$/` and made
 * Export throw for anyone whose theme was called "Café". HIVE-146 deleted that
 * module, and `<a download>` accepts anything — so nothing rejects a name any
 * more and this is no longer a gate.
 *
 * It stays because the *filename* is still worth getting right: a download
 * called `日本語.json` or `my theme!!.json` is a worse artefact than
 * `cafe.json`, on every filesystem the file might land on next.
 *
 * `\w` is ASCII-only. Latin diacritics are transliterated first
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
 * Write `contents` under `suggestedName`, sanitised to a bare `.json` filename.
 *
 * Returns nothing. It used to resolve a boolean — `false` meaning the user
 * cancelled the native save dialog — and there is no dialog left to cancel, so
 * the value was always `true` and both call sites already discarded it. A
 * constant return that callers ignore is a question the API is no longer
 * asking.
 *
 * Still `async`: it can reject (a blocked `createObjectURL`, a `click` that
 * throws), and the gallery's `void` lets that surface as an unhandled
 * rejection in the console rather than swallowing it.
 */
export async function saveThemeFile(
  suggestedName: string,
  contents: string,
): Promise<void> {
  saveThemeFileInBrowser(sanitizeFileName(suggestedName), contents);
}

function saveThemeFileInBrowser(name: string, contents: string): void {
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
}
