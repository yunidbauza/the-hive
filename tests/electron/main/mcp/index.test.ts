import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_CONFIG_FILE } from '../../../../electron/main/mcp/paths';
import { createMcpRuntime } from '../../../../electron/main/mcp/index';

describe('createMcpRuntime', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-mcp-rt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('offers no path before it has started', () => {
    const runtime = createMcpRuntime({
      userDataPath: dir,
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    expect(runtime.configPathFor()).toBeNull();
  });

  it('writes the file and offers its path after a successful start', async () => {
    const runtime = createMcpRuntime({
      userDataPath: dir,
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    await runtime.start();

    const expected = join(dir, MCP_CONFIG_FILE);
    expect(runtime.configPathFor()).toBe(expected);
    expect((await stat(expected)).isFile()).toBe(true);
  });

  it('memoises the write: a second start() joins the same promise instead of writing again', async () => {
    /*
      HIVE-112 fix: `registerIpcHandlers` fires `start()` once, unawaited, at
      construction, and the `ptySpawn`/`ptyRestart` handlers `await` it again
      on the spawn path so a session can never observe `configPathFor()`
      returning `null` merely because the write had not settled yet. That only
      works if a second `start()` shares the first call's promise rather than
      triggering a second write.
    */
    const runtime = createMcpRuntime({
      userDataPath: dir,
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    const first = runtime.start();
    const second = runtime.start();

    expect(second).toBe(first);
    await Promise.all([first, second]);

    const expected = join(dir, MCP_CONFIG_FILE);
    expect(runtime.configPathFor()).toBe(expected);
  });

  it('keeps answering null when the write failed, so the flag is omitted', async () => {
    /*
      A session that starts without ledger tools works; one that does not
      start because a file could not be written does not, and nothing on
      screen would connect the two — so the runtime logs it instead of
      throwing. Spied on rather than left to leak, the way the skills
      runtime's own equivalent test does it.
    */
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    // A path under a file, which cannot be made into a directory.
    const runtime = createMcpRuntime({
      userDataPath: '/dev/null/nope',
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.configPathFor()).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('MCP config could not be written'));
  });

  /**
   * `hiveServerSpec()` (HIVE-123, task 2 review finding) — the same
   * `written`-flag gate as `configPathFor()`, proven directly rather than
   * only through a wake-command test that mocks the runtime away.
   */
  it('offers no hive server spec before it has started', () => {
    const runtime = createMcpRuntime({
      userDataPath: dir,
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    expect(runtime.hiveServerSpec()).toBeNull();
  });

  it('offers the hive server descriptor after a successful start', async () => {
    const runtime = createMcpRuntime({
      userDataPath: dir,
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    await runtime.start();

    expect(runtime.hiveServerSpec()).toEqual({
      command: '/bin/app',
      args: ['/out/mcp-host.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('keeps answering null for the hive server spec when the write failed', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    // A path under a file, which cannot be made into a directory.
    const runtime = createMcpRuntime({
      userDataPath: '/dev/null/nope',
      execPath: '/bin/app',
      scriptPath: '/out/mcp-host.js',
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.hiveServerSpec()).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('MCP config could not be written'));
  });
});
