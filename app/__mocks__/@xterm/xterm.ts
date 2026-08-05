import { vi } from 'vitest';

/**
 * Recording fake for xterm's `Terminal`.
 *
 * xterm needs a DOM measurement path that happy-dom does not provide — it
 * performs no layout, so a cell can never be measured — and unit tests
 * therefore never touch a real instance. The contract (story 013): anything
 * that genuinely requires a rendered terminal — colours on screen, selection,
 * scrollback behaviour — is asserted in Playwright (story 070), not here.
 *
 * Lives in `__mocks__/` adjacent to `node_modules`, so Vitest substitutes it
 * for the real package automatically.
 */

export interface MockTerminalOptions {
  [key: string]: unknown;
}

/** Every instance constructed during a test, in construction order. */
export const terminalInstances: MockTerminal[] = [];

export class MockTerminal {
  options: MockTerminalOptions;
  /** Everything written to the terminal, in order. */
  readonly written: string[] = [];
  /** The element passed to `open()`, or null while unopened. */
  opened: HTMLElement | null = null;
  disposed = false;
  cols = 80;
  rows = 24;

  /**
   * Rows a test can stage, indexed from `baseY`. Empty by default, so a buffer
   * that was never set up reports no line and the surface falls back to
   * chord-only — the same "absent information is not a match" default the real
   * read has.
   */
  bufferLines: string[] = [];

  readonly buffer = {
    active: {
      viewportY: 0,
      baseY: 0,
      cursorY: 0,
      cursorX: 0,
      /**
       * Enough of xterm's `IBufferLine` for the bare-`←` decision (story 095):
       * `translateToString(trimRight, start, end)`. Returns `undefined` for a
       * row that was never staged, exactly as xterm does past the buffer's end.
       */
      getLine: (row: number) => {
        const text = this.bufferLines[row];
        if (text === undefined) return undefined;
        return {
          translateToString: (trimRight?: boolean, start?: number, end?: number) => {
            const slice = text.slice(start ?? 0, end);
            return trimRight === true ? slice.replace(/\s+$/u, '') : slice;
          },
        };
      },
    },
  };

  readonly loadAddon = vi.fn();
  readonly focus = vi.fn();
  readonly scrollToBottom = vi.fn();
  readonly clear = vi.fn();
  readonly paste = vi.fn();

  /**
   * The custom key handler the surface installs (story 095), plus a selection
   * a test can stage.
   *
   * Recorded rather than invoked: the handler is a pure decision over a key
   * event, so a test drives it directly with a synthetic event and asserts the
   * boolean. Real xterm would have to be typed into.
   */
  keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
  selection = '';

  private readonly dataListeners = new Set<(data: string) => void>();

  constructor(options: MockTerminalOptions = {}) {
    this.options = { ...options };
    terminalInstances.push(this);
  }

  open(element: HTMLElement) {
    this.opened = element;
  }

  /**
   * The callback is invoked synchronously. Real xterm parses asynchronously and
   * fires it afterwards, but the ordering guarantee that production code relies
   * on — "the data is in the buffer by the time this runs" — is preserved, and
   * a synchronous fake keeps tests free of timer plumbing.
   */
  write(data: string, done?: () => void) {
    this.written.push(data);
    done?.();
  }

  writeln(data: string) {
    this.written.push(`${data}\n`);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyEventHandler = handler;
  }

  hasSelection() {
    return this.selection !== '';
  }

  getSelection() {
    return this.selection;
  }

  clearSelection() {
    this.selection = '';
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  /** Test helper — simulate the user typing into the terminal. */
  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  dispose() {
    this.disposed = true;
    this.dataListeners.clear();
  }
}

/** Drop every recorded instance. Call between tests. */
export function resetTerminalInstances() {
  terminalInstances.length = 0;
}

export { MockTerminal as Terminal };
