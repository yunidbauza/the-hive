// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseMcpGet, readSlackStatus } from '../../../../../electron/main/integrations/slack/status';

const CONNECTED = `slack:
  Scope: User config
  Status: ✓ Connected
  Type: http
  URL: https://mcp.slack.com/mcp
`;

const NEEDS_AUTH = `slack:
  Scope: User config
  Status: ! Needs authentication
  Type: http
`;

describe('parseMcpGet', () => {
  it('reads a connected server', () => {
    expect(parseMcpGet(CONNECTED)).toEqual({ kind: 'connected' });
  });

  it('reads a server that is added but not authenticated', () => {
    expect(parseMcpGet(NEEDS_AUTH)).toEqual({ kind: 'needs-auth' });
  });

  it('treats output with no Status line as not-added', () => {
    expect(parseMcpGet('No MCP server found')).toEqual({ kind: 'not-added' });
  });
});

describe('readSlackStatus', () => {
  it('is not-added when the command exits non-zero', () => {
    const run = () => ({ code: 1, stdout: '', stderr: 'No MCP server found' });

    expect(readSlackStatus('claude', run)).toEqual({ kind: 'not-added' });
  });

  it('ignores the SEP-2352 warning the sdk writes to stderr', () => {
    const run = () => ({
      code: 0,
      stdout: CONNECTED,
      stderr: "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp",
    });

    expect(readSlackStatus('claude', run)).toEqual({ kind: 'connected' });
  });

  it('asks about the user scope — a local server is invisible to an agent', () => {
    const calls: string[][] = [];
    const run = (_file: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 0, stdout: CONNECTED, stderr: '' };
    };

    readSlackStatus('claude', run);

    expect(calls[0]).toEqual(['mcp', 'get', 'slack', '--scope', 'user']);
  });

  it('reports a thrown spawn failure as an error rather than throwing', () => {
    const run = () => {
      throw new Error('spawn ENOENT');
    };

    expect(readSlackStatus('claude', run)).toEqual({
      kind: 'error',
      message: 'Could not run claude: spawn ENOENT',
    });
  });
});
