import { describe, expect, it } from 'vitest';

import {
  ACTION_SCOPE,
  isThisMachineAction,
  type NotificationAction,
} from '@shared/notification-contract';

/**
 * Which machine answers a notification's click (HIVE-151).
 *
 * `notifications:act` is one channel carrying seven verbs, and the remote proxy
 * routed it by channel name alone: while attached, a `url` click opened a
 * browser on the server and an `update.*` click drove the server's updater.
 * This table is what makes the split a property of the action rather than
 * something each call site has to remember.
 */

/**
 * Every member of the union, once.
 *
 * Written as literals rather than derived from `ACTION_SCOPE`'s own keys on
 * purpose: a test that reads its subject's table to decide what to assert
 * cannot notice that table losing an entry, which is the one failure the
 * `satisfies` clause exists to catch at compile time and this exists to catch
 * if the clause is ever loosened.
 */
const EVERY_ACTION: readonly NotificationAction[] = [
  { type: 'none' },
  { type: 'session', entityId: 's1' },
  { type: 'url', url: 'https://example.com' },
  { type: 'ask', thread: 't1' },
  { type: 'agent', name: 'scout' },
  { type: 'update.download' },
  { type: 'update.install' },
];

describe('ACTION_SCOPE', () => {
  it('classifies every member of NotificationAction', () => {
    expect(Object.keys(ACTION_SCOPE).sort()).toEqual(
      EVERY_ACTION.map((action) => action.type).sort(),
    );
  });

  it('scopes the three that reach this machine’s hardware to this machine', () => {
    expect(ACTION_SCOPE.url).toBe('this-machine');
    expect(ACTION_SCOPE['update.download']).toBe('this-machine');
    expect(ACTION_SCOPE['update.install']).toBe('this-machine');
  });

  it('scopes the four that resolve against fleet state to the fleet', () => {
    expect(ACTION_SCOPE.none).toBe('fleet');
    expect(ACTION_SCOPE.session).toBe('fleet');
    expect(ACTION_SCOPE.ask).toBe('fleet');
    expect(ACTION_SCOPE.agent).toBe('fleet');
  });
});

describe('isThisMachineAction', () => {
  it('agrees with the table for every member', () => {
    for (const action of EVERY_ACTION) {
      expect(isThisMachineAction(action)).toBe(
        ACTION_SCOPE[action.type] === 'this-machine',
      );
    }
  });

  it('narrows to the three this-machine members', () => {
    const action: NotificationAction = { type: 'url', url: 'https://example.com' };
    if (!isThisMachineAction(action)) throw new Error('expected a this-machine action');
    /*
      A type-level assertion as much as a runtime one: this line stops
      compiling if `ThisMachineAction` ever widens to the whole union, which is
      the drift the derived type exists to prevent.
    */
    const narrowed: 'url' | 'update.download' | 'update.install' = action.type;
    expect(narrowed).toBe('url');
  });

  it('refuses every fleet member', () => {
    expect(isThisMachineAction({ type: 'ask', thread: 't1' })).toBe(false);
    expect(isThisMachineAction({ type: 'session', entityId: 's1' })).toBe(false);
    expect(isThisMachineAction({ type: 'agent', name: 'scout' })).toBe(false);
    expect(isThisMachineAction({ type: 'none' })).toBe(false);
  });
});
