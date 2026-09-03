import type { RunAsync } from '../github/run';

/**
 * Giving `claude mcp login` a terminal, because it now insists on having one.
 *
 * ## What changed under us
 *
 * `login.ts` was built on a premise that was true at `claude` 2.1.252 and is
 * false at 2.1.259: that the sign-in "needs no tty of its own", because the
 * browser is where the flow actually happens and a loopback callback on port
 * 3118 is what ends it. The CLI now checks `process.stdin.isTTY` at the moment
 * its callback server starts listening and **aborts the whole flow** when
 * stdin is not a terminal — before the browser has had a chance to answer:
 *
 * ```
 * Couldn't complete authentication for "slack": stdin isn't a terminal, so
 * authentication can't be completed here. Re-run in an interactive terminal…
 * ```
 *
 * The terminal is wanted for a *fallback* — pasting the redirect URL by hand
 * when the callback cannot reach back — so the browser half still works
 * perfectly. The CLI simply refuses to wait for it without somewhere to fall
 * back to. Measured both ways: with stdin a pipe the run dies at once with
 * that sentence; with stdin a pty the same command prints its URL and waits.
 *
 * ## Why `/usr/bin/script` and not a pty of our own
 *
 * `node-pty` deliberately lives in the pty-host utility process — a segfault
 * in a native addon must not be a segfault in main — and main's sanctioned
 * pty is `Sessions.openCommand`, which streams its output to the renderer as
 * a terminal rather than returning it to the caller. Neither fits a settings
 * verb that has to answer with a `RunResult`.
 *
 * `script` is a system binary present on every macOS, which is the only
 * platform this app packages for. It costs no addon, no ABI rebuild and no
 * new IPC, and — because it is a decorator over the same injected
 * {@link RunAsync} every other Slack verb uses — the per-verb timeout, the
 * `maxBuffer` cap and the quit `AbortSignal` all keep applying unchanged.
 *
 * Two things were measured rather than assumed, because the fix would be
 * quietly broken without either:
 *
 * - **The exit status propagates.** A child exiting 7 makes `script` exit 7,
 *   so `login.ts` still reads the CLI's own answer.
 * - **Killing `script` takes the child with it.** The child's controlling
 *   terminal disappears with the master, so a timeout or a quit-time abort
 *   really does release port 3118 — the leak the `AbortSignal` exists to
 *   prevent, and the one this would have reintroduced silently.
 *
 * ## The cost, and what pays it
 *
 * One pty carries all three streams, so the child's stdout and stderr arrive
 * merged on `script`'s stdout, painted with the escape sequences a terminal
 * would have consumed. {@link readTranscript} undoes the painting; reading a
 * *transcript* rather than a stderr stream is why `login.ts` captions its
 * failure from the last line rather than the first (`outcome.ts`).
 */

/** The pty allocator. An absolute path, like every other binary main spawns. */
export const TTY_LAUNCHER = '/usr/bin/script';

/**
 * `-q` suppresses the "Script started/done" banner, and `/dev/null` is where
 * the typescript file goes — the copy on `script`'s own stdout is the one we
 * read, and a real file would be a temp path to create and clean up.
 */
export const TTY_LAUNCHER_ARGS: readonly string[] = ['-q', '/dev/null'];

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * An operating-system command — `ESC ] … BEL` or `ESC ] … ESC \`.
 *
 * Hyperlinks arrive this way: `OSC 8` wraps a link *around* text that already
 * spells the same URL, so dropping the sequence loses nothing and keeps a
 * caption from carrying the address twice.
 */
const OSC = new RegExp(`${ESC}\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');

/**
 * A run of cursor-motion and erase sequences — `G`, `H`, `f`, `J`, `K`.
 *
 * This is how a program starts a line over, so in a transcript it is a line
 * break and not nothing: read as nothing, the prompt a failing sign-in clears
 * ends up glued to the message that replaced it. A *run* collapses to one
 * break because a single redraw is routinely several sequences (`ESC[1G`
 * then `ESC[0J`), and that is one new line, not two.
 */
const REDRAW = new RegExp(`(?:${ESC}\\[[0-9;?]*[GHJKf])+`, 'g');

/** Everything else introduced by CSI — colour, bold, cursor visibility. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Any escape sequence left, two characters wide. */
const ESCAPED = new RegExp(`${ESC}.`, 'g');

/** A control character, newline excepted. */
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return character !== '\n' && (code < 0x20 || code === 0x7f);
};

/**
 * A pty transcript as the text a person would have read off the screen.
 *
 * Mechanical only: it undoes the painting and nothing else. Trimming, blank
 * lines and which line becomes the caption belong to `outcome.ts`, which
 * already owns that decision for every other Slack verb.
 */
export function readTranscript(raw: string): string {
  const text = raw
    .replace(OSC, '')
    .replace(REDRAW, '\n')
    .replace(CSI, '')
    .replace(ESCAPED, '')
    /*
      `\r\n` first, or the pair becomes two breaks. A lone `\r` really is a
      break here: a terminal would have drawn what follows over the top.
    */
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  return (
    [...text]
      .filter((character) => !isControl(character))
      .join('')
      // A terminal draws nothing for these, and a caption should not either.
      .replace(/[ \t]+\n/g, '\n')
  );
}

/** The same run, with a controlling terminal and a readable transcript. */
export const withTty =
  (run: RunAsync): RunAsync =>
  async (file, args, options) => {
    const result = await run(
      TTY_LAUNCHER,
      [...TTY_LAUNCHER_ARGS, file, ...args],
      options,
    );

    return {
      ...result,
      stdout: readTranscript(result.stdout),
      stderr: readTranscript(result.stderr),
    };
  };
