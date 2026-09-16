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

/** Enough of xterm's `ILink` for a test to drive one. */
export interface MockLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
}

/** Enough of xterm's `ILinkProvider`. */
export interface MockLinkProvider {
  provideLinks(y: number, callback: (links: MockLink[] | undefined) => void): void;
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

  /**
   * Which cells of {@link bufferLines} are faint, as a per-row mask (HIVE-79).
   *
   * One character per column: `d` for a dim cell, anything else for a normal
   * one. A row with no entry is entirely normal, which is what almost every
   * test wants — only the ones staging Claude's input placeholder care.
   */
  bufferDim: string[] = [];

  /**
   * Which cells of {@link bufferLines} are double-width, as a per-row mask.
   *
   * One character per string index: `w` for a character xterm would draw in
   * two columns — CJK, most emoji — anything else for a single-column one. A
   * row with no entry is entirely narrow, which is what almost every test
   * wants; only the ones about link ranges care.
   */
  bufferWide: string[] = [];

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
      /**
       * xterm's reusable cell. The surface passes it to `getCell` so a row read
       * on every `←` does not allocate one object per column; this fake ignores
       * it and answers from the staged strings.
       */
      getNullCell: () => ({
        getChars: () => '',
        getWidth: () => 1,
        isDim: () => 0,
      }),
      getLine: (row: number) => {
        const text = this.bufferLines[row];
        if (text === undefined) return undefined;
        const faint = this.bufferDim[row] ?? '';
        const wide = this.bufferWide[row] ?? '';
        const width = [...text].reduce(
          (total, _char, i) => total + (wide[i] === 'w' ? 2 : 1),
          0,
        );
        return {
          // Real xterm reports a row's length in **columns**, not characters.
          length: width,
          translateToString: (trimRight?: boolean, start?: number, end?: number) => {
            const slice = text.slice(start ?? 0, end);
            return trimRight === true ? slice.replace(/\s+$/u, '') : slice;
          },
          /**
           * Enough of `IBufferCell` for the placeholder rule (HIVE-79).
           *
           * `isDim` is the load-bearing one: Claude Code draws the hint in its
           * empty input with `\x1b[2m`, and telling that from a typed message
           * is the whole reason the surface reads cells rather than calling
           * `translateToString`.
           */
          /**
           * Indexed by **column**, as real xterm is — so a row holding a
           * double-width character has more columns than string characters,
           * and the spacer cell after one reports no chars and width 0.
           */
          getCell: (column: number) => {
            let at = 0;
            for (let i = 0; i < text.length; i += 1) {
              const width = wide[i] === 'w' ? 2 : 1;
              if (column === at) {
                return {
                  getChars: () => text[i] ?? '',
                  getWidth: () => width,
                  isDim: () => (faint[i] === 'd' ? 1 : 0),
                };
              }
              // The spacer half of a wide character: real xterm reports it
              // with no chars and width 0.
              if (width === 2 && column === at + 1) {
                return {
                  getChars: () => '',
                  getWidth: () => 0,
                  isDim: () => (faint[i] === 'd' ? 1 : 0),
                };
              }
              at += width;
            }
            return undefined;
          },

        };
      },
    },
  };

  readonly loadAddon = vi.fn();
  readonly focus = vi.fn();

  /**
   * xterm's helper textarea — the element that actually holds focus.
   *
   * Undefined until a test stages one, matching real xterm before `open()`.
   * The surface compares it against `document.activeElement` to decide whether
   * a terminal that just lost its GPU context should reclaim the caret
   * (HIVE-53), so a fake with no textarea correctly reports "not focused".
   */
  textarea: HTMLTextAreaElement | undefined;
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

  /**
   * Link providers the surface registers (terminal file links).
   *
   * Recorded rather than invoked, for the same reason as the key handler
   * above: `provideLinks` is a decision over a line of text, so a test drives
   * it directly against staged {@link bufferLines} and asserts what comes
   * back. Real xterm would need a *rendered* row and a real mouse over it,
   * and the WebGL renderer paints the row into a canvas with no node to hover.
   */
  readonly linkProviders: MockLinkProvider[] = [];

  registerLinkProvider(provider: MockLinkProvider) {
    this.linkProviders.push(provider);
    return {
      dispose: () => {
        const at = this.linkProviders.indexOf(provider);
        if (at >= 0) this.linkProviders.splice(at, 1);
      },
    };
  }

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
