// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { probeSlack } from '../../../../../electron/main/integrations/slack/probe';

const init = (servers: unknown) =>
  `${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers })}\n`;

describe('probeSlack', () => {
  it('is connected when the run reports the server attached', () => {
    const run = () => ({ code: 0, stdout: init([{ name: 'slack', status: 'connected' }]), stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'connected' });
  });

  it('is needs-auth when the init event says so', () => {
    const run = () => ({ code: 0, stdout: init([{ name: 'slack', status: 'needs-auth' }]), stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'needs-auth' });
  });

  it('is pending-approval when the tool call reports the server unapproved', () => {
    const stdout = `${init([{ name: 'slack', status: 'connected' }])}${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'The Slack MCP server has not been approved by a workspace admin.',
    })}\n`;
    const run = () => ({ code: 0, stdout, stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'pending-approval' });
  });

  it('is an error when no init event arrives at all', () => {
    const run = () => ({ code: 1, stdout: '', stderr: 'boom' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'error', message: 'boom' });
  });
});
