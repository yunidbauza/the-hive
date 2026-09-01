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

const NOT_CONNECTED = `slack:
  Scope: User config
  Status: ✗ Not connected
  Type: http
`;

const DISCONNECTED = `slack:
  Scope: User config
  Status: Disconnected
  Type: http
`;

/**
 * The glyph is decoration, and a build that dropped it must not break the read.
 *
 * The earlier strip was `^Status:\s*\S*\s*`, which assumed a whitespace-
 * delimited glyph token was always there: on this line it ate the word
 * `Connected` itself and reported an error on a healthy server.
 */
const NO_GLYPH = `slack:
  Scope: User config
  Status: Connected
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

  it('rejects "Not connected" as an error, not connected', () => {
    expect(parseMcpGet(NOT_CONNECTED)).toEqual({
      kind: 'error',
      message: 'Status: ✗ Not connected',
    });
  });

  it('reads a connected server whose line carries no glyph', () => {
    expect(parseMcpGet(NO_GLYPH)).toEqual({ kind: 'connected' });
  });

  it('rejects "Disconnected" as an error, not connected', () => {
    expect(parseMcpGet(DISCONNECTED)).toEqual({
      kind: 'error',
      message: 'Status: Disconnected',
    });
  });
});

describe('readSlackStatus', () => {
  it('is not-added when the command exits non-zero', () => {
    const run = () => ({ code: 1, stdout: '', stderr: 'No MCP server found' });

    expect(readSlackStatus('claude', run)).toEqual({ kind: 'not-added' });
  });

  /**
   * `-1` is `gh.ts`'s marker for a process killed by signal — where its
   * five-second timeout lands. Folded into the non-zero branch it read as "not
   * signed in", offering a sign-in button for a `claude` that had hung.
   */
  it('reports a signalled death as an error, not as "not signed in"', () => {
    const run = () => ({ code: -1, stdout: '', stderr: '' });
    const status = readSlackStatus('claude', run);

    expect(status.kind).toBe('error');
    expect(status).not.toEqual({ kind: 'not-added' });
  });

  it('ignores the SEP-2352 warning the sdk writes to stderr', () => {
    const run = () => ({
      code: 0,
      stdout: CONNECTED,
      stderr: "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp",
    });

    expect(readSlackStatus('claude', run)).toEqual({ kind: 'connected' });
  });

  it('runs `claude mcp get slack` with no scope argument', () => {
    const calls: string[][] = [];
    const run = (_file: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 0, stdout: CONNECTED, stderr: '' };
    };

    readSlackStatus('claude', run);

    expect(calls[0]).toEqual(['mcp', 'get', 'slack']);
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
