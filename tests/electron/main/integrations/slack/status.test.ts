// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  parseMcpGet,
  readSlackStatus,
  SLACK_GET_TIMEOUT_MS,
} from '../../../../../electron/main/integrations/slack/status';
import { TIMED_OUT } from '../../../../../electron/main/integrations/slack/outcome';

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

const answer = (over: Partial<{ code: number; stdout: string; stderr: string; timedOut: boolean }>) => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

describe('readSlackStatus', () => {
  it('is not-added when the command exits non-zero', async () => {
    const run = () => Promise.resolve(answer({ code: 1, stderr: 'No MCP server found' }));

    await expect(readSlackStatus('claude', run)).resolves.toEqual({ kind: 'not-added' });
  });

  /**
   * `-1` is the runner's marker for a process killed by signal — where its
   * timeout lands. Folded into the non-zero branch it read as "not signed in",
   * offering a sign-in button for a `claude` that had hung.
   */
  it('reports a signalled death as an error, not as "not signed in"', async () => {
    const run = () => Promise.resolve(answer({ code: -1 }));
    const status = await readSlackStatus('claude', run);

    expect(status.kind).toBe('error');
    expect(status).not.toEqual({ kind: 'not-added' });
  });

  it('names the timeout when the read is the thing that hung', async () => {
    const run = () => Promise.resolve(answer({ code: -1, timedOut: true }));

    await expect(readSlackStatus('claude', run)).resolves.toEqual({
      kind: 'error',
      message: TIMED_OUT,
    });
  });

  it('ignores the SEP-2352 warning the sdk writes to stderr', async () => {
    const run = () =>
      Promise.resolve(
        answer({
          stdout: CONNECTED,
          stderr: "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp",
        }),
      );

    await expect(readSlackStatus('claude', run)).resolves.toEqual({ kind: 'connected' });
  });

  /**
   * The runner, and the argv. `mcp get` health-checks the server over HTTP —
   * about 1.7 s measured — so on `gh.ts`'s five-second `spawnSync` helper it
   * was a network call blocking the main process, and two components ask for
   * it on mount. That it is `async` is expressed by the signature; that it does
   * not simply inherit the twenty-second `gh` default is what this pins.
   */
  it('runs `claude mcp get slack` on the async runner, with no scope argument', async () => {
    const calls: { args: string[]; timeoutMs: number | undefined }[] = [];
    const run = (
      _file: string,
      args: readonly string[],
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ args: [...args], timeoutMs: options?.timeoutMs });

      return Promise.resolve(answer({ stdout: CONNECTED }));
    };

    await readSlackStatus('claude', run);

    expect(calls[0]?.args).toEqual(['mcp', 'get', 'slack']);
    expect(calls[0]?.timeoutMs).toBe(SLACK_GET_TIMEOUT_MS);
  });

  it('reports a thrown spawn failure as an error rather than throwing', async () => {
    const run = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(readSlackStatus('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'Could not run claude: spawn ENOENT',
    });
  });
});
