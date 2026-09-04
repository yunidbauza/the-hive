// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_SESSIONS_DIR,
  containerOrigins,
  removeSessionContainerFiles,
  sweepSessionContainerFiles,
  writeSessionContainerFiles,
  writeSharedContainerFiles,
} from '../../../../electron/main/container/generated';

const ORIGINS = {
  url: 'http://127.0.0.1:63999/hook',
  origin: 'http://127.0.0.1:63999',
  metricsUrl: 'http://127.0.0.1:63999/statusline',
  readyUrl: 'http://127.0.0.1:63999/ready',
};

const ALIAS = 'host.docker.internal';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-container-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('containerOrigins', () => {
  it('swaps the host on every URL and touches no path', () => {
    const swapped = containerOrigins(ORIGINS, ALIAS);

    expect(swapped.url).toBe('http://host.docker.internal:63999/hook');
    expect(swapped.metricsUrl).toBe(
      'http://host.docker.internal:63999/statusline',
    );
    expect(swapped.readyUrl).toBe('http://host.docker.internal:63999/ready');
  });

  it('leaves a bare origin without a trailing slash', () => {
    /*
      A `new URL()` round-trip would add one, and `mcp-host` builds its request
      paths onto this value — the gained slash is a 404 on every ledger call.
    */
    expect(containerOrigins(ORIGINS, ALIAS).origin).toBe(
      'http://host.docker.internal:63999',
    );
  });

  it('carries no optional URL the receiver did not have', () => {
    const swapped = containerOrigins(
      { url: ORIGINS.url, origin: ORIGINS.origin },
      ALIAS,
    );

    expect(swapped.metricsUrl).toBeUndefined();
    expect(swapped.readyUrl).toBeUndefined();
  });
});

describe('writeSharedContainerFiles', () => {
  it('writes the whole set beside the host one, never over it', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    const written = await readdir(join(dir, 'hive', 'container'));

    expect(written.sort()).toEqual([
      'claude-agent.settings.json',
      'claude-hooks.settings.json',
      'hive.mcp.json',
      'statusline.sh',
    ]);
  });

  it('holds no resolved secret — exec-env files are mountable read-only', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    const settings = await readFile(
      join(dir, 'hive', 'container', 'claude-hooks.settings.json'),
      'utf8',
    );
    const mcp = await readFile(
      join(dir, 'hive', 'container', 'hive.mcp.json'),
      'utf8',
    );

    expect(settings).toContain('$HIVE_HOOK_TOKEN');
    expect(mcp).toContain('${HIVE_HOOK_TOKEN}');
  });

  it('addresses the container alias, not loopback', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    const settings = await readFile(
      join(dir, 'hive', 'container', 'claude-hooks.settings.json'),
      'utf8',
    );

    expect(settings).toContain('host.docker.internal');
    expect(settings).not.toContain('127.0.0.1');
  });

  it('leaves the host set alone', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    const hive = await readdir(join(dir, 'hive'));

    expect(hive).toEqual(['container']);
  });
});

describe('writeSessionContainerFiles', () => {
  const identity = { session: 'sess-1', token: 'deadbeef' };

  it('writes one directory per session, because the token is per session', async () => {
    await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    const settings = await readFile(
      join(dir, CONTAINER_SESSIONS_DIR, 'sess-1', 'claude-hooks.settings.json'),
      'utf8',
    );

    expect(settings).toContain('deadbeef');
    expect(settings).not.toContain('$HIVE_HOOK_TOKEN');
  });

  it('resolves the MCP config too, not only the hooks', async () => {
    await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    const mcp = await readFile(
      join(dir, CONTAINER_SESSIONS_DIR, 'sess-1', 'hive.mcp.json'),
      'utf8',
    );

    expect(mcp).toContain('deadbeef');
    expect(mcp).toContain('http://host.docker.internal:63999/mcp');
    expect(mcp).not.toContain('${');
  });

  it('a restarted Hive writes a file carrying the new token', async () => {
    const origins = containerOrigins(ORIGINS, ALIAS);

    await writeSessionContainerFiles(dir, 'sess-1', origins, identity);
    await writeSessionContainerFiles(dir, 'sess-1', origins, {
      session: 'sess-1',
      token: 'feedface',
    });

    const settings = await readFile(
      join(dir, CONTAINER_SESSIONS_DIR, 'sess-1', 'claude-hooks.settings.json'),
      'utf8',
    );

    expect(settings).toContain('feedface');
    expect(settings).not.toContain('deadbeef');
  });

  it('keeps one session token out of another session directory', async () => {
    const origins = containerOrigins(ORIGINS, ALIAS);

    await writeSessionContainerFiles(dir, 'sess-1', origins, identity);
    await writeSessionContainerFiles(dir, 'sess-2', origins, {
      session: 'sess-2',
      token: 'feedface',
    });

    const first = await readFile(
      join(dir, CONTAINER_SESSIONS_DIR, 'sess-1', 'claude-hooks.settings.json'),
      'utf8',
    );

    expect(first).not.toContain('feedface');
  });

  it('returns the directory it wrote', async () => {
    const written = await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    expect(written).toBe(join(dir, CONTAINER_SESSIONS_DIR, 'sess-1'));
  });
});

describe('the mode a resolved token is written with', () => {
  const identity = { session: 'sess-1', token: 'deadbeef' };

  const modeOf = async (path: string): Promise<string> =>
    ((await stat(path)).mode & 0o777).toString(8);

  it('keeps every rewrite file owner-only, not just the script', async () => {
    const root = await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    /*
      All three carry the same live token the script does. A 0644 here is a
      token any local user can read and authenticate every call with.
    */
    expect(await modeOf(join(root, 'claude-hooks.settings.json'))).toBe('600');
    expect(await modeOf(join(root, 'claude-agent.settings.json'))).toBe('600');
    expect(await modeOf(join(root, 'hive.mcp.json'))).toBe('600');
    expect(await modeOf(join(root, 'statusline.sh'))).toBe('700');
  });

  it('leaves the secret-free exec-env set readable, so it can be mounted', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    expect(await modeOf(join(dir, 'hive', 'container', 'hive.mcp.json'))).toBe(
      '644',
    );
  });

  it('tightens a file that already existed at the looser mode', async () => {
    /*
      `writeFile`'s mode applies only on create. The shared set is written first
      here, so the per-session path would inherit 0644 without the explicit
      chmod — and would keep it for the rest of the file's life.
    */
    const root = join(dir, CONTAINER_SESSIONS_DIR, 'sess-1');

    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'hive.mcp.json'), '{}', {
      encoding: 'utf8',
      mode: 0o644,
    });

    await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    expect(await modeOf(join(root, 'hive.mcp.json'))).toBe('600');
  });
});

describe('the options only the placing caller knows', () => {
  const identity = { session: 'sess-1', token: 'deadbeef' };

  it('carries the run into a rewrite config, so concurrent runs stay apart', async () => {
    const root = await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
      { run: 'run-7' },
    );

    const mcp = JSON.parse(
      await readFile(join(root, 'hive.mcp.json'), 'utf8'),
    ) as { mcpServers: { hive: { headers: Record<string, string> } } };

    expect(mcp.mcpServers.hive.headers['x-hive-run']).toBe('run-7');
  });

  it('sends an empty run for a pty session, which the route reads as absent', async () => {
    const root = await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      identity,
    );

    const mcp = JSON.parse(
      await readFile(join(root, 'hive.mcp.json'), 'utf8'),
    ) as { mcpServers: { hive: { headers: Record<string, string> } } };

    expect(mcp.mcpServers.hive.headers['x-hive-run']).toBe('');
  });

  it('names the status line script where the container will see it', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS), {
      containerRoot: '/opt/hive',
    });

    const settings = JSON.parse(
      await readFile(
        join(dir, 'hive', 'container', 'claude-hooks.settings.json'),
        'utf8',
      ),
    ) as { statusLine: { command: string } };

    expect(settings.statusLine.command).toContain('/opt/hive/statusline.sh');
    expect(settings.statusLine.command).not.toContain(dir);
  });

  it('falls back to the real path, which is right for a same-path mount', async () => {
    await writeSharedContainerFiles(dir, containerOrigins(ORIGINS, ALIAS));

    const settings = JSON.parse(
      await readFile(
        join(dir, 'hive', 'container', 'claude-hooks.settings.json'),
        'utf8',
      ),
    ) as { statusLine: { command: string } };

    expect(settings.statusLine.command).toContain(
      join(dir, 'hive', 'container', 'statusline.sh'),
    );
  });
});

describe('removeSessionContainerFiles', () => {
  it('takes the resolved token off disk when the session ends', async () => {
    await writeSessionContainerFiles(
      dir,
      'sess-1',
      containerOrigins(ORIGINS, ALIAS),
      { session: 'sess-1', token: 'deadbeef' },
    );
    await removeSessionContainerFiles(dir, 'sess-1');

    const left = await readdir(join(dir, CONTAINER_SESSIONS_DIR));

    expect(left).toEqual([]);
  });

  it('is silent about a session that has no directory', async () => {
    await expect(
      removeSessionContainerFiles(dir, 'never-written'),
    ).resolves.toBeUndefined();
  });
});

describe('sweepSessionContainerFiles', () => {
  it('clears orphans a crash left behind, keeping the live ones', async () => {
    await mkdir(join(dir, CONTAINER_SESSIONS_DIR, 'orphan'), {
      recursive: true,
    });
    await writeFile(
      join(dir, CONTAINER_SESSIONS_DIR, 'orphan', 'claude-hooks.settings.json'),
      '{}',
      'utf8',
    );
    await mkdir(join(dir, CONTAINER_SESSIONS_DIR, 'live'), { recursive: true });

    await sweepSessionContainerFiles(dir, ['live']);

    const left = await readdir(join(dir, CONTAINER_SESSIONS_DIR));

    expect(left).toEqual(['live']);
  });

  it('clears everything when nothing is live', async () => {
    await mkdir(join(dir, CONTAINER_SESSIONS_DIR, 'orphan'), {
      recursive: true,
    });

    await sweepSessionContainerFiles(dir, []);

    expect(await readdir(join(dir, CONTAINER_SESSIONS_DIR))).toEqual([]);
  });

  it('is silent when nothing has ever been written', async () => {
    await expect(sweepSessionContainerFiles(dir, [])).resolves.toBeUndefined();
  });
});
