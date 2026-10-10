/**
 * Files dropped onto a terminal, as the text a shell should see.
 *
 * A macOS terminal answers a drop from Finder by typing the file's path at the
 * caret. This module is the two halves of that: the paths the drop really
 * carried, and the one string that names them all safely.
 */

/**
 * The real path behind each dropped `File`, in drop order.
 *
 * Only preload can answer — `webUtils.getPathForFile` is not reachable from a
 * context-isolated page — and it answers only for a `File` the browser built
 * from a real drop. One the page constructed comes back `null` and is left
 * out here. No bridge is the browser build, which has no paths to give.
 */
export function droppedPaths(files: readonly File[]): string[] {
  const bridge = window.hive;
  if (!bridge) return [];

  const paths: string[] = [];
  for (const file of files) {
    const path = bridge.pty.droppedPath(file);
    if (path !== null) paths.push(path);
  }
  return paths;
}

/**
 * C0, DEL and C1. A file name may hold any of them, and none is text to a
 * terminal: ESC can close bracketed paste early (`ESC [ 201 ~`) and type the
 * rest of the name as keystrokes, and a newline submits the line.
 */
const holdsControl = (path: string): boolean =>
  Array.from(path).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

/**
 * Single-quote each path for a POSIX shell, joined by spaces, with one space
 * after the last so the next word can be typed straight away.
 *
 * Single quotes make every character inert *to the shell* except `'` itself,
 * which closes the quote, is escaped, and reopens it (`'\''`). They do nothing
 * for the terminal, which reads the bytes first, so a path holding a control
 * character is left out whole — not stripped, because a stripped path names a
 * different file. `null` when nothing is left, so a drop that carried nothing
 * usable pastes nothing rather than a lone space.
 */
export function quoteDroppedPaths(paths: readonly string[]): string | null {
  const safe = paths.filter((path) => !holdsControl(path));
  if (safe.length === 0) return null;
  return `${safe.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')} `;
}
