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
/**
 * What a consumer does with one chunk of backend output.
 *
 * `parsed` is the acknowledgement half of story 093's flow control, and it is
 * **the one thing this interface gained when the real backend arrived** (story
 * 094). It is documented here rather than buried in `PtyTransport` because it
 * is a contract between the two sides, and the reason it exists is not
 * guessable from the signature.
 *
 * A pty can produce output faster than xterm can parse it. Batching alone does
 * not fix that — only acknowledgement does — and an ack is only meaningful if
 * it means *parsed*, not *received*. `xterm.write` is asynchronous; its
 * callback fires once the chunk is actually in the buffer. So the transport
 * cannot know when a chunk has landed, and the surface cannot know what a
 * sequence number is. `parsed` is the handshake between those two facts: the
 * transport supplies it, the surface calls it from `terminal.write`'s callback.
 *
 * Acking on arrival instead would measure the IPC channel and learn nothing
 * about whether the terminal is keeping up, which is the entire question. Not
 * acking at all would let the unacked window fill and pause the pty
 * permanently — a terminal that stops after half a megabyte and never resumes.
 *
 * Optional, so a transport with no backpressure (`StaticTransport`) simply
 * omits it and every existing caller keeps compiling.
 */
export type TerminalDataHandler = (chunk: string, parsed?: () => void) => void;

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
  onData(cb: TerminalDataHandler): () => void;

  /** Tell the backend the viewport geometry changed. */
  resize(cols: number, rows: number): void;
}
