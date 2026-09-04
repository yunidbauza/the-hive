import { describe, expect, it } from 'vitest';

import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_RUN,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_RUN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '@shared/hook-contract';
import { MCP_PATH, MCP_SERVER_NAME } from '@shared/mcp-contract';

import {
  containerHiveServerSpec,
  containerMcpConfig,
} from '../../../../electron/main/mcp/container-config';

describe('containerHiveServerSpec — exec-env', () => {
  it('addresses the receiver through the environment, never a resolved host', () => {
    const spec = containerHiveServerSpec('exec-env');

    expect(spec.type).toBe('http');
    expect(spec.url).toBe(`\${${HOOK_ENV_RECEIVER_URL}}${MCP_PATH}`);
  });

  it('carries the run header with a `:-` default so a pty session sends empty', () => {
    const spec = containerHiveServerSpec('exec-env');

    expect(spec.headers[HOOK_HEADER_RUN]).toBe(`\${${HOOK_ENV_RUN}:-}`);
  });

  it('references the session and token rather than resolving them', () => {
    const spec = containerHiveServerSpec('exec-env');

    expect(spec.headers[HOOK_HEADER_SESSION]).toBe(`\${${HOOK_ENV_SESSION}}`);
    expect(spec.headers[HOOK_HEADER_TOKEN]).toBe(`\${${HOOK_ENV_TOKEN}}`);
  });

  it('holds no secret at all — the file is mountable read-only', () => {
    const file = containerMcpConfig('exec-env');

    expect(file).not.toContain('secret');
    expect(file).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('containerHiveServerSpec — rewrite', () => {
  const resolved = {
    receiverUrl: 'http://host.docker.internal:63999',
    session: 'sess-1',
    token: 'deadbeef',
    run: 'run-7',
  };

  it('bakes the resolved origin, because the container env is stale', () => {
    const spec = containerHiveServerSpec('rewrite', resolved);

    expect(spec.url).toBe(`http://host.docker.internal:63999${MCP_PATH}`);
  });

  it('bakes the session, token and run', () => {
    const spec = containerHiveServerSpec('rewrite', resolved);

    expect(spec.headers[HOOK_HEADER_SESSION]).toBe('sess-1');
    expect(spec.headers[HOOK_HEADER_TOKEN]).toBe('deadbeef');
    expect(spec.headers[HOOK_HEADER_RUN]).toBe('run-7');
  });

  it('sends an empty run for a pty session, which the route reads as absent', () => {
    const spec = containerHiveServerSpec('rewrite', {
      ...resolved,
      run: undefined,
    });

    expect(spec.headers[HOOK_HEADER_RUN]).toBe('');
  });

  it('refuses to emit without the values it must bake', () => {
    expect(() => containerHiveServerSpec('rewrite')).toThrow(
      /rewrite needs resolved values/,
    );
  });
});

describe('containerMcpConfig', () => {
  it('names the server `hive`, which is what makes tools `mcp__hive__*`', () => {
    const parsed = JSON.parse(containerMcpConfig('exec-env')) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it('ends with a newline, like every other generated file', () => {
    expect(containerMcpConfig('exec-env').endsWith('}\n')).toBe(true);
  });
});
