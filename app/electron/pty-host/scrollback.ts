import { TRUNCATION_NOTICE } from '@shared/pty-host-protocol';

/**
 * Bounded scrollback for one session (story 092).
 *
 * It exists for one reason: a `TerminalSurface` that mounts late must still
 * show the transcript. `TerminalTransport.onData`'s contract already promises
 * this — "the transport is expected to replay whatever scrollback it already
 * holds before the first live chunk" (story 042) — and terminals mount lazily
 * on first visit, so a session running while the user was elsewhere has output
 * that predates its surface.
 *
 * Bounded, because a session running a verbose build for an hour must not grow
 * the host's memory without limit.
 */
export class Scrollback {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private dropped = false;
  // Declared rather than a parameter property: `erasableSyntaxOnly` bans the
  // shorthand, since it is syntax that emits code rather than being erased.
  private readonly capBytes: number;

  constructor(capBytes: number) {
    this.capBytes = capBytes;
  }

  push(chunk: string): void {
    if (chunk === '') return;

    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk);

    /**
     * Drop whole chunks from the front rather than slicing bytes.
     *
     * Slicing would be exact, and would also mean re-encoding the whole
     * buffer on every write once the cap is reached — under a `yes` flood
     * that is the most expensive thing in the process. Dropping whole chunks
     * is O(1) amortised and overshoots by at most one chunk, which node-pty
     * keeps small.
     *
     * The last chunk is never dropped: a buffer holding a single
     * larger-than-cap chunk still has to show *something*.
     */
    while (this.bytes > this.capBytes && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks.shift()!);
      this.dropped = true;
    }
  }

  /**
   * Everything held, prefixed with the truncation marker when output was lost.
   *
   * The marker is not decoration. A partial transcript that does not announce
   * itself reads as a complete one, and the user draws conclusions from a
   * build log whose first half is missing.
   */
  read(): string {
    const text = this.chunks.join('');
    return this.dropped ? TRUNCATION_NOTICE + text : text;
  }

  /** True once any output has been dropped. */
  get truncated(): boolean {
    return this.dropped;
  }

  /** Bytes currently held, excluding the marker. */
  get size(): number {
    return this.bytes;
  }
}
