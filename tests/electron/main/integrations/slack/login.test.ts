// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { signInToSlack, signOutOfSlack } from '../../../../../electron/main/integrations/slack/login';
import { SLACK_CALLBACK_PORT, SLACK_CLIENT_ID, SLACK_MCP_URL } from '@shared/slack-contract';

const ok = () => ({ code: 0, stdout: 'Status: ✓ Connected', stderr: '' });

describe('signInToSlack', () => {
  it('adds the server with Slack\'s own client id, at user scope', () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return ok();
    };

    signInToSlack('claude', run);

    expect(calls[0]).toEqual([
      'mcp', 'add', '--transport', 'http', 'slack', SLACK_MCP_URL,
      '--client-id', SLACK_CLIENT_ID,
      '--callback-port', String(SLACK_CALLBACK_PORT),
      '--scope', 'user',
    ]);
    expect(calls[1]).toEqual(['mcp', 'login', 'slack']);
  });

  it('does not attempt the login when the add fails', () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 1, stdout: '', stderr: 'bad url' };
    };

    const status = signInToSlack('claude', run);

    expect(calls).toHaveLength(1);
    expect(status).toEqual({ kind: 'error', message: 'bad url' });
  });

  it('reports a failed browser flow with the reason the cli gave', () => {
    let call = 0;
    const run = () => {
      call += 1;

      return call === 1
        ? ok()
        : { code: 1, stdout: '', stderr: 'callback port 3118 is in use' };
    };

    expect(signInToSlack('claude', run)).toEqual({
      kind: 'error',
      message: 'callback port 3118 is in use',
    });
  });
});

describe('signOutOfSlack', () => {
  it('removes the server at user scope and reports not-added', () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return ok();
    };

    expect(signOutOfSlack('claude', run)).toEqual({ kind: 'not-added' });
    expect(calls[0]).toEqual(['mcp', 'remove', 'slack', '--scope', 'user']);
  });
});
