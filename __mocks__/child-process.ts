import { vi } from 'vitest';

/**
 * Recording fake for `node:child_process` (HIVE-115).
 *
 * The same rule `AGENTS.md` states for `node-pty`, for the same reason and one
 * more. A unit test that really spawned `claude` would leak a process past a
 * failing assertion, need network and credentials, and cost money per run.
 * What a unit test proves here is plumbing — argv, cwd, env, how stdout is
 * folded, which signal is sent when — and every one of those is observable
 * from a recording.
 *
 * What only a real binary can show (that the flags exist, that hooks fire,
 * that `--resume` picks up the session) is `pnpm test:agent`.
 */

export interface MockSpawnCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

export const spawnCalls: MockSpawnCall[] = [];
export const childInstances: MockChild[] = [];

class MockStream {
  private readonly listeners: ((chunk: Buffer) => void)[] = [];

  on(event: string, cb: (chunk: Buffer) => void) {
    if (event === 'data') this.listeners.push(cb);
    return this;
  }

  emit(chunk: string) {
    for (const cb of [...this.listeners]) cb(Buffer.from(chunk, 'utf8'));
  }
}

export class MockChild {
  readonly stdout = new MockStream();
  readonly stderr = new MockStream();
  readonly killSignals: (string | undefined)[] = [];

  pid: number | undefined = 5150;
  killed = false;

  private readonly exitListeners: ((
    code: number | null,
    signal: string | null,
  ) => void)[] = [];
  private readonly closeListeners: ((
    code: number | null,
    signal: string | null,
  ) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  readonly kill = vi.fn((signal?: string) => {
    this.killSignals.push(signal);
    this.killed = true;
    return true;
  });

  on(event: string, cb: (...args: never[]) => void) {
    if (event === 'exit') {
      this.exitListeners.push(
        cb as (code: number | null, signal: string | null) => void,
      );
    }

    if (event === 'close') {
      this.closeListeners.push(
        cb as (code: number | null, signal: string | null) => void,
      );
    }

    if (event === 'error') this.errorListeners.push(cb as (e: Error) => void);

    return this;
  }

  /** Test-only: push stdout as if the child had written it. */
  emitStdout(chunk: string) {
    this.stdout.emit(chunk);
  }

  emitStderr(chunk: string) {
    this.stderr.emit(chunk);
  }

  /**
   * Test-only: fire 'exit' — the process ended, but stdio may not be fully
   * drained yet. Does not by itself finalize a run; see `emitClose`.
   */
  emitExit(code: number | null = 0, signal: string | null = null) {
    for (const cb of [...this.exitListeners]) cb(code, signal);
  }

  /** Test-only: fire 'close' — stdio has drained. This is what finalizes a run. */
  emitClose(code: number | null = 0, signal: string | null = null) {
    for (const cb of [...this.closeListeners]) cb(code, signal);
  }

  /** Test-only: fail the spawn itself. */
  emitError(error: Error) {
    for (const cb of [...this.errorListeners]) cb(error);
  }
}

export const spawn = vi.fn(
  (file: string, args: readonly string[], options: Record<string, unknown>) => {
    spawnCalls.push({ file, args, options });

    const child = new MockChild();

    childInstances.push(child);

    return child;
  },
);

/** Drop every recorded call and instance. Call between tests. */
export function resetChildProcessMock() {
  spawnCalls.length = 0;
  childInstances.length = 0;
  spawn.mockClear();
}

export default { spawn };
