// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { RunAsync, RunResult } from '../../../../electron/main/integrations/github/run';
import {
  createBranchReader,
  MIN_INTERVAL_MS,
} from '../../../../electron/main/sessions/git';

/**
 * Reading a session's real branch (HIVE-78).
 *
 * `run` is injected throughout — a test that shelled out to `git` would answer
 * differently in every checkout, and the reader's whole job is *how it reads*
 * the answer and *how often it asks*, neither of which needs a real process.
 */

const ok = (stdout: string): RunResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

const failed = (code = 128): RunResult => ({
  code,
  stdout: '',
  stderr: 'fatal: not a git repository',
  timedOut: false,
});

function reader(
  run: RunAsync,
  now: () => number = () => 0,
) {
  return createBranchReader({ run, gitPath: () => '/usr/bin/git', now });
}

describe('createBranchReader', () => {
  it('reads the branch checked out in a directory', async () => {
    const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));

    await expect(reader(run).read('/repo')).resolves.toBe('main');

    expect(run).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['-C', '/repo', 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('reads a worktree branch — the case this exists for', async () => {
    /**
     * The reported defect: an agent creates a worktree, and the rail goes on
     * showing the branch the session opened on. The directory is the hook
     * payload's `cwd`, so this is the whole mechanism.
     */
    const run = vi
      .fn<RunAsync>()
      .mockResolvedValue(ok('feat/incorp-332-adhoc-scrape-tier-inputs-metrics\n'));

    await expect(
      reader(run).read('/repo/.claude/worktrees/incorp-332'),
    ).resolves.toBe('feat/incorp-332-adhoc-scrape-tier-inputs-metrics');
  });

  it('answers null for a detached HEAD', async () => {
    /**
     * Why `--abbrev-ref HEAD` and not `git branch --show-current`: the latter
     * prints an empty line here, making "detached" indistinguishable from "the
     * command failed". `HEAD` is unambiguous.
     */
    const run = vi.fn<RunAsync>().mockResolvedValue(ok('HEAD\n'));

    await expect(reader(run).read('/repo')).resolves.toBeNull();
  });

  it('answers null outside a work tree', async () => {
    const run = vi.fn<RunAsync>().mockResolvedValue(failed());

    await expect(reader(run).read('/not-a-repo')).resolves.toBeNull();
  });

  it('answers null when git is not installed, without spawning', async () => {
    // A machine with no `git` is not an error state for a terminal
    // multiplexer — it is a session whose branch column reads an em dash.
    const run = vi.fn<RunAsync>();
    const none = createBranchReader({ run, gitPath: () => null, now: () => 0 });

    await expect(none.read('/repo')).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  describe('resolving git', () => {
    it('remembers a successful resolution instead of probing per read', async () => {
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const gitPath = vi.fn(() => '/usr/bin/git');
      const branches = createBranchReader({ run, gitPath, now: () => 0 });

      await branches.read('/a');
      await branches.read('/b');

      expect(gitPath).toHaveBeenCalledTimes(1);
    });

    it('re-probes while git is unresolved, so a config fix needs no restart', async () => {
      /**
       * The asymmetry that matters. A GUI-launched Electron app on macOS gets a
       * minimal `PATH`; the user fixes it through `runtime.path` and reloads the
       * config. Caching the *failure* would leave every branch read answering
       * `null` until the app was restarted, with nothing on screen to explain
       * it.
       */
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const gitPath = vi
        .fn<() => string | null>()
        .mockReturnValueOnce(null)
        .mockReturnValue('/usr/bin/git');
      const branches = createBranchReader({ run, gitPath, now: () => 0 });

      await expect(branches.read('/a')).resolves.toBeNull();
      branches.forget('/a');
      await expect(branches.read('/a')).resolves.toBe('main');

      expect(gitPath).toHaveBeenCalledTimes(2);
    });
  });

  describe('freshness', () => {
    it('bypasses the floor for a turn boundary', async () => {
      /**
       * The bug this exists for: an agent runs `git checkout -b` inside a turn
       * shorter than the floor, `Stop` is suppressed, and the rail shows the old
       * branch until the user's *next* prompt — which is exactly when they are
       * looking at it to see what just happened.
       */
      const run = vi
        .fn<RunAsync>()
        .mockResolvedValueOnce(ok('main\n'))
        .mockResolvedValueOnce(ok('feat/x\n'));
      const clock = { t: 0 };
      const branches = reader(run, () => clock.t);

      await branches.read('/repo');
      clock.t = MIN_INTERVAL_MS / 2;

      await expect(branches.read('/repo', true)).resolves.toBe('feat/x');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('still joins a read already in flight', async () => {
      // `fresh` means "no stale cached answer", not "start a second process".
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const branches = reader(run);

      const [a, b] = await Promise.all([
        branches.read('/repo'),
        branches.read('/repo', true),
      ]);

      expect([a, b]).toEqual(['main', 'main']);
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it('answers null when the binary cannot be executed at all', async () => {
    // `runAsync` rejects only for a spawn failure. This must not escape into a
    // hook callback, where it would be an unhandled rejection on main.
    const run = vi.fn<RunAsync>().mockRejectedValue(new Error('ENOENT'));

    await expect(reader(run).read('/repo')).resolves.toBeNull();
  });

  it('refuses output carrying a newline', async () => {
    // A branch name cannot contain one, so this is some other program's output
    // arriving on a hijacked stdout. Refused rather than truncated.
    const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\nrogue\n'));

    await expect(reader(run).read('/repo')).resolves.toBeNull();
  });

  describe('cost', () => {
    it('serves a repeat read from cache inside the interval', async () => {
      /**
       * The property that makes a hook boundary an affordable cadence.
       * `UserPromptSubmit`, `PermissionRequest` and `Stop` can arrive several
       * times a turn; without this each one is a process spawn.
       */
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const clock = { t: 0 };
      const branches = reader(run, () => clock.t);

      await branches.read('/repo');
      clock.t = MIN_INTERVAL_MS - 1;
      await expect(branches.read('/repo')).resolves.toBe('main');

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('reads again once the interval has passed', async () => {
      const run = vi
        .fn<RunAsync>()
        .mockResolvedValueOnce(ok('main\n'))
        .mockResolvedValueOnce(ok('feat/new\n'));
      const clock = { t: 0 };
      const branches = reader(run, () => clock.t);

      await branches.read('/repo');
      clock.t = MIN_INTERVAL_MS;

      await expect(branches.read('/repo')).resolves.toBe('feat/new');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('shares one spawn between concurrent reads', async () => {
      // A burst of hook events arriving together must not start several `git`
      // processes racing for the same answer.
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const branches = reader(run);

      const [a, b, c] = await Promise.all([
        branches.read('/repo'),
        branches.read('/repo'),
        branches.read('/repo'),
      ]);

      expect([a, b, c]).toEqual(['main', 'main', 'main']);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('keys the cache by directory, so two repositories do not share', async () => {
      const run = vi
        .fn<RunAsync>()
        .mockResolvedValueOnce(ok('main\n'))
        .mockResolvedValueOnce(ok('develop\n'));
      const branches = reader(run);

      await expect(branches.read('/a')).resolves.toBe('main');
      await expect(branches.read('/b')).resolves.toBe('develop');
    });

    it('forgets a directory on request', async () => {
      const run = vi.fn<RunAsync>().mockResolvedValue(ok('main\n'));
      const branches = reader(run);

      await branches.read('/repo');
      branches.forget('/repo');
      await branches.read('/repo');

      expect(run).toHaveBeenCalledTimes(2);
    });
  });
});
