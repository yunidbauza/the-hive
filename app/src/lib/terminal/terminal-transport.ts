/**
 * THE SEAM.
 *
 * Every byte the terminal renders, and every keystroke it produces, crosses
 * this interface. `TerminalSurface` is written against it and nothing else —
 * no store, no fixtures, no feature slice — which is what makes replacing the
 * backend a one-file change rather than a component rewrite.
 *
 * Today the only implementation is `StaticTransport`, which replays fixture
 * transcripts out of the store. When the PTY daemon lands, a `PtyTransport`
 * implementing these same three methods drops in and no component changes.
 *
 * The rule that keeps it honest (story 042): if a future story needs the
 * terminal component to read the store, that story is wrong — the data belongs
 * in a transport.
 */
export interface TerminalTransport {
  /** User keystrokes heading for the backend. A no-op while read-only. */
  write(data: string): void;

  /**
   * Subscribe to backend output. The transport is expected to replay whatever
   * scrollback it already holds before the first live chunk, so a surface that
   * mounts late still shows the full transcript.
   *
   * Returns an unsubscribe function; callers must invoke it on unmount.
   */
  onData(cb: (chunk: string) => void): () => void;

  /** Tell the backend the viewport geometry changed. */
  resize(cols: number, rows: number): void;
}
