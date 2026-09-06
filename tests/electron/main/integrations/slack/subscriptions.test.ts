// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  needsSocket,
  readSubscriptions,
  type SubscribableAgent,
} from '../../../../../electron/main/integrations/slack/subscriptions';

const agent = (over: Partial<SubscribableAgent>): SubscribableAgent => ({
  name: 'a',
  paused: false,
  valid: true,
  on: [],
  ...over,
});

describe('readSubscriptions', () => {
  it('indexes a channel by name, lowercased', () => {
    const subs = readSubscriptions([
      agent({ name: 'pr-patrol', on: ['ledger', 'slack.channel:#Eng-Code-Review'] }),
    ]);
    expect(subs.channels.get('#eng-code-review')).toEqual(['pr-patrol']);
    expect(needsSocket(subs)).toBe(true);
  });

  it('puts two agents on one channel', () => {
    const subs = readSubscriptions([
      agent({ name: 'a', on: ['slack.channel:#x'] }),
      agent({ name: 'b', on: ['slack.channel:#x'] }),
    ]);
    expect(subs.channels.get('#x')).toEqual(['a', 'b']);
  });

  it('collects mention subscribers apart from channels', () => {
    const subs = readSubscriptions([
      agent({ name: 'a', on: ['slack.app_mention'] }),
      agent({ name: 'b', on: ['slack.channel:#x'] }),
    ]);
    expect(subs.mentions).toEqual(['a']);
    expect(subs.channels.get('#x')).toEqual(['b']);
  });

  it('ignores slack.mention, which is a poll instruction and not a push trigger', () => {
    const subs = readSubscriptions([agent({ name: 'a', on: ['slack.mention'] })]);
    expect(subs.mentions).toEqual([]);
    expect(needsSocket(subs)).toBe(false);
  });

  it('leaves a paused agent out, so pausing the last one closes the socket', () => {
    const subs = readSubscriptions([
      agent({ name: 'a', paused: true, on: ['slack.channel:#x'] }),
    ]);
    expect(subs.channels.size).toBe(0);
    expect(needsSocket(subs)).toBe(false);
  });

  it('leaves an invalid definition out', () => {
    const subs = readSubscriptions([
      agent({ name: 'a', valid: false, on: ['slack.app_mention'] }),
    ]);
    expect(subs.mentions).toEqual([]);
  });

  it('knows every enabled agent by name, whatever it subscribes to', () => {
    const subs = readSubscriptions([
      agent({ name: 'acr', on: ['ledger'] }),
      agent({ name: 'pr-patrol', on: ['slack.app_mention'] }),
      agent({ name: 'off', paused: true, on: ['ledger'] }),
    ]);
    expect(subs.known).toEqual(['acr', 'pr-patrol']);
  });

  it('needs no socket when nothing subscribes', () => {
    expect(needsSocket(readSubscriptions([agent({ on: ['ledger'] })]))).toBe(false);
    expect(needsSocket(readSubscriptions([]))).toBe(false);
  });
});
