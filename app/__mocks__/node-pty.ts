import { vi } from 'vitest';

/**
 * Recording fake for `node-pty` (story 084).
 *
 * The same rule `AGENTS.md` already states for xterm, for a different reason.
 * With xterm the mock is a necessity — happy-dom performs no layout, so xterm
 * can never measure a cell. Here the real module *would* load: `node-pty@1.1.0`
 * ships N-API prebuilds that are ABI-stable, so Vitest on plain Node can
 * `require` it successfully.
 *
 * It is mocked anyway, because a unit test that spawns real processes is a unit
 * test that leaks them. Every `spawn()` is a fork, a pty pair and a child that
 * outlives a failing assertion. Main-process tests assert *plumbing* — spawn
 * arguments, cwd resolution, write/resize/kill routing, exit handling — and
 * terminal semantics get their own runner under Electron's ABI (story 098).
 */

export interface MockSpawnCall {
  file: string;
  args: string[] | string;
  options: Record<string, unknown>;
}

/** Every `spawn()` since the last reset, in order. */
export const spawnCalls: MockSpawnCall[] = [];

/** Every pty handed out since the last reset, in order. */
export const ptyInstances: MockPty[] = [];

export class MockPty {
  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn<(cols: number, rows: number) => void>();
  readonly kill = vi.fn<(signal?: string) => void>();
  readonly pause = vi.fn();
  readonly resume = vi.fn();

  pid = 4242;
  cols: number;
  rows: number;
  process: string;

  private readonly dataListeners: ((chunk: string | Buffer) => void)[] = [];
  private readonly exitListeners: ((e: {
    exitCode: number;
    signal?: number;
  }) => void)[] = [];

  constructor(file: string, options: Record<string, unknown>) {
    this.process = file;
    this.cols = (options.cols as number) ?? 80;
    this.rows = (options.rows as number) ?? 24;
    ptyInstances.push(this);
  }

  /** Mirrors node-pty's disposable-returning listener API. */
  onData(cb: (chunk: string | Buffer) => void) {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        const at = this.dataListeners.indexOf(cb);
        if (at !== -1) this.dataListeners.splice(at, 1);
      },
    };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        const at = this.exitListeners.indexOf(cb);
        if (at !== -1) this.exitListeners.splice(at, 1);
      },
    };
  }

  /**
   * Test-only: push output as if the child had written it.
   *
   * Accepts a `Buffer` because story 092 spawns with `encoding: null`, so the
   * real module emits Buffers rather than strings — the one option node-pty's
   * own types do not model. A mock that could only emit strings would make the
   * split-multi-byte-character defect untestable, which is precisely the
   * defect the `StringDecoder` exists to prevent.
   */
  emitData(chunk: string | Buffer) {
    for (const cb of [...this.dataListeners]) cb(chunk);
  }

  /** Test-only: end the process. */
  emitExit(exitCode = 0, signal?: number) {
    for (const cb of [...this.exitListeners]) cb({ exitCode, signal });
  }
}

export const spawn = vi.fn(
  (file: string, args: string[] | string, options: Record<string, unknown>) => {
    spawnCalls.push({ file, args, options });
    return new MockPty(file, options);
  },
);

/** Drop every recorded call and instance. Call between tests. */
export function resetPtyMock() {
  spawnCalls.length = 0;
  ptyInstances.length = 0;
  spawn.mockClear();
}

export default { spawn };
