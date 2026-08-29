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
});
