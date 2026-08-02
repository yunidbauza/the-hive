import { vi } from 'vitest';

/**
 * Recording fake for xterm's `Terminal`.
 *
 * xterm needs a real canvas and a DOM measurement path that happy-dom does not
 * provide, so unit tests never touch a real instance. The contract (story 013):
 * anything that genuinely requires a rendered terminal — colours on screen,
 * selection, scrollback behaviour — is asserted in Playwright (story 070), not
 * here. Do not chase canvas assertions in unit tests.
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

  readonly buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } };

  readonly loadAddon = vi.fn();
  readonly focus = vi.fn();
  readonly scrollToBottom = vi.fn();
  readonly clear = vi.fn();

  private readonly dataListeners = new Set<(data: string) => void>();

  constructor(options: MockTerminalOptions = {}) {
    this.options = { ...options };
    terminalInstances.push(this);
  }

  open(element: HTMLElement) {
    this.opened = element;
  }

  write(data: string) {
    this.written.push(data);
  }

  writeln(data: string) {
    this.written.push(`${data}\n`);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
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
