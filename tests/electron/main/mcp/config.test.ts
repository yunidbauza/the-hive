import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mcpConfig, writeMcpConfig } from '../../../../electron/main/mcp/config';

describe('mcpConfig', () => {
  const options = { execPath: '/Apps/Hive.app/Contents/MacOS/Hive', scriptPath: '/out/mcp-host.js' };

  it('names the server "hive" so tools resolve as mcp__hive__*', () => {
    expect(Object.keys(JSON.parse(mcpConfig(options)).mcpServers)).toEqual(['hive']);
  });

  it("uses the app's own binary rather than a system node", () => {
    const server = JSON.parse(mcpConfig(options)).mcpServers.hive;

    expect(server.command).toBe('/Apps/Hive.app/Contents/MacOS/Hive');
    expect(server.args).toEqual(['/out/mcp-host.js']);
  });

  it('runs that binary as node', () => {
    // Without this the Electron binary opens a window instead of running a script.
    expect(JSON.parse(mcpConfig(options)).mcpServers.hive.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('ends with a newline, like every other file this app generates', () => {
    expect(mcpConfig(options).endsWith('}\n')).toBe(true);
  });
});

describe('writeMcpConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-mcp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the parent directory when it is not there', async () => {
    const path = join(dir, 'hive', 'hive.mcp.json');
    await writeMcpConfig(path, { execPath: '/bin/app', scriptPath: '/out/mcp-host.js' });

    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.hive.command).toBe('/bin/app');
  });

  it('rewrites rather than appends, so a stale path from an older build cannot survive', async () => {
    const path = join(dir, 'hive.mcp.json');
    await writeMcpConfig(path, { execPath: '/old/app', scriptPath: '/old/mcp-host.js' });
    await writeMcpConfig(path, { execPath: '/new/app', scriptPath: '/new/mcp-host.js' });

    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.mcpServers.hive.command).toBe('/new/app');
    expect(parsed.mcpServers.hive.args).toEqual(['/new/mcp-host.js']);
  });
});
