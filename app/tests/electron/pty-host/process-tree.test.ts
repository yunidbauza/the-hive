// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createProcessControl,
  parseProcessTable,
  walkDescendants,
} from '../../../electron/pty-host/process-tree';

/**
 * Reading and signalling the process tree (HIVE-72).
 *
 * No test here execs a real `ps` or signals a real process — the table is a
 * fixture and the reader is injected. What is being asserted is the parsing
 * and the walk, which is where the defect's fix actually lives: a descendant
 * that job control moved into its own process group has to be *found* before
 * it can be killed.
 */

/**
 * `ps -eo pid=,ppid=,pgid=` output — padded columns, no header.
 *
 * Shell 100 backgrounded job 200 with `&`, so job control gave 200 a process
 * group of its own; 201 is the `sleep` it started, inside that same group.
 * 300 is an unrelated process that must never be touched.
 */
const TABLE = [
  '    1     0     1',
  '  100    99   100',
  '  200   100   200',
  '  201   200   200',
  '  300    99   300',
].join('\n');

describe('parseProcessTable', () => {
  it('reads pid, ppid and pgid from padded columns', () => {
    expect(parseProcessTable(TABLE)).toContainEqual({
      pid: 201,
      ppid: 200,
      pgid: 200,
    });
  });

  it('skips lines that are not three numbers', () => {
    const rows = parseProcessTable('  bad line\n\n  100    99   100\n');

    expect(rows).toEqual([{ pid: 100, ppid: 99, pgid: 100 }]);
  });

  it('drops any row whose pid or pgid could not be safely signalled', () => {
    /**
     * `kill(-0, sig)` is `kill(0, sig)` — every process in the *caller's* own
     * group, i.e. the pty-host shooting itself — and `kill(-1, sig)` is every
     * process the user owns. Linux reports pgid 0 for kernel threads, so a
     * row like this is not hypothetical, and `isAlive` is no guard: the
     * permission check on pid 0 succeeds.
     */
    const rows = parseProcessTable(
      ['    0     0     0', '    1     0     1', '   -1    99    -1', '  100    99   100'].join(
        '\n',
      ),
    );

    expect(rows).toEqual([{ pid: 100, ppid: 99, pgid: 100 }]);
  });

  it('keeps a row whose ppid is 0 or 1, which is ordinary', () => {
    // Only pid and pgid are ever signalled; a parent of init is just the top
    // of the tree, and dropping those rows would break the walk.
    expect(parseProcessTable('  100     1   100\n')).toEqual([
      { pid: 100, ppid: 1, pgid: 100 },
    ]);
  });
});

describe('walkDescendants', () => {
  it('finds the whole subtree, not just direct children', () => {
    expect(walkDescendants(parseProcessTable(TABLE), [100])).toEqual([
      { pid: 200, pgid: 200 },
      { pid: 201, pgid: 200 },
    ]);
  });

  it('reports the descendant its own process group, which is the whole bug', () => {
    // 200 was backgrounded with `&` by an interactive shell, so job control put
    // it in a group of its own. `kill(-100)` structurally cannot reach it.
    const [job] = walkDescendants(parseProcessTable(TABLE), [100]);

    expect(job!.pgid).not.toBe(100);
  });

  it('excludes the roots themselves', () => {
    const found = walkDescendants(parseProcessTable(TABLE), [100]);

    expect(found.map((d) => d.pid)).not.toContain(100);
  });

  it('leaves unrelated processes alone', () => {
    const found = walkDescendants(parseProcessTable(TABLE), [100]);

    expect(found.map((d) => d.pid)).not.toContain(300);
  });

  it('walks several roots in one pass', () => {
    // `killAll` hands over every live session's shell at once, so one `ps`
    // covers the whole app rather than one per session.
    const rows = parseProcessTable(`${TABLE}\n  400   300   400`);

    const found = walkDescendants(rows, [100, 300]);

    expect(found.map((d) => d.pid).sort()).toEqual([200, 201, 400]);
  });

  it('reports nothing twice when one root sits under another', () => {
    const found = walkDescendants(parseProcessTable(TABLE), [100, 200]);

    // 200 is a root, so it is excluded like any other root; 201 is reached
    // once despite being reachable from both.
    expect(found.map((d) => d.pid)).toEqual([201]);
  });

  it('terminates on a ppid cycle instead of hanging the quit path', () => {
    const rows = parseProcessTable('  10    11    10\n  11    10    11\n');

    expect(walkDescendants(rows, [10])).toEqual([{ pid: 11, pgid: 11 }]);
  });

  it('answers nothing for a root with no children', () => {
    expect(walkDescendants(parseProcessTable(TABLE), [300])).toEqual([]);
  });
});

describe('descendants', () => {
  it('finds the backgrounded job under its root', async () => {
    const control = createProcessControl({
      readTable: () => Promise.resolve(TABLE),
      platform: 'darwin',
    });

    await expect(control.descendants([100])).resolves.toEqual([
      { pid: 200, pgid: 200 },
      { pid: 201, pgid: 200 },
    ]);
  });

  it('reads no process table when there are no roots', async () => {
    const readTable = vi.fn(() => Promise.resolve(TABLE));
    const control = createProcessControl({ readTable, platform: 'darwin' });

    await expect(control.descendants([])).resolves.toEqual([]);
    expect(readTable).not.toHaveBeenCalled();
  });

  it('resolves empty rather than rejecting when `ps` fails', async () => {
    // Teardown then falls back to the group kill it did before — strictly no
    // worse than today. Blocking the app's quit path would be worse than both.
    const control = createProcessControl({
      readTable: () => Promise.resolve(''),
      platform: 'darwin',
    });

    await expect(control.descendants([100])).resolves.toEqual([]);
  });

  it('execs nothing on win32, where there is no `ps`', async () => {
    const readTable = vi.fn(() => Promise.resolve(TABLE));
    const control = createProcessControl({ readTable, platform: 'win32' });

    await expect(control.descendants([100])).resolves.toEqual([]);
    expect(readTable).not.toHaveBeenCalled();
  });
});

describe('signal guards', () => {
  it('refuses to signal group 0, which would be the host’s own group', () => {
    const control = createProcessControl({ platform: 'darwin' });

    // If this ever regresses, the pty-host SIGKILLs itself and every session
    // with it. Asserted by not throwing *and* not signalling: a real
    // `process.kill(-0, 'SIGKILL')` would end this test process.
    expect(() => control.signalGroup(0, 'SIGKILL')).not.toThrow();
    expect(() => control.signalPid(0, 'SIGKILL')).not.toThrow();
  });

  it('refuses pid -1, which is every process the user owns', () => {
    const control = createProcessControl({ platform: 'darwin' });

    expect(() => control.signalPid(-1, 'SIGKILL')).not.toThrow();
    expect(() => control.signalGroup(-1, 'SIGKILL')).not.toThrow();
  });

  it('refuses init', () => {
    const control = createProcessControl({ platform: 'darwin' });

    expect(() => control.signalPid(1, 'SIGKILL')).not.toThrow();
  });
});

describe('isAlive', () => {
  it('answers true for a process that exists', () => {
    const control = createProcessControl({ platform: 'darwin' });

    // This process, which is by definition running.
    expect(control.isAlive(process.pid)).toBe(true);
  });

  it('answers false rather than throwing for one that does not', () => {
    const control = createProcessControl({ platform: 'darwin' });

    // Above the pid ceiling on both platforms that matter.
    expect(control.isAlive(0x7fffffff)).toBe(false);
  });
});
