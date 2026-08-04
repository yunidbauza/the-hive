// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNotifier } from '../../../../electron/main/notifications';
import {
  DEFAULT_NOTIFICATIONS,
  emptySnapshot,
  type NotificationPrefs,
} from '../../../../electron/shared/config-contract';
import { CH } from '../../../../electron/shared/ipc-contract';

/**
 * The OS notification emitter (story 106).
 *
 * The presenter is injected, so nothing here touches Electron's `Notification`
 * — what is worth testing is *which* events become a notification and which do
 * not, and that is a decision this module makes on its own.
 */

interface Shown {
  title: string;
  body: string;
  onClick: () => void;
}

function harness(over: Partial<NotificationPrefs> = {}) {
  const shown: Shown[] = [];
  const activated: string[] = [];
  const notifier = createNotifier({
    prefs: () => ({ ...DEFAULT_NOTIFICATIONS, ...over }),
    present: (options) => shown.push(options),
    activate: (entityId) => activated.push(entityId),
  });

  return { notifier, shown, activated };
}

const cloneEvent = (ok: boolean) => ({
  ok,
  targetPath: ok ? '/tmp/repo' : null,
  reason: ok ? null : 'authentication failed',
  snapshot: emptySnapshot('/tmp/config.json'),
});

describe('sessions', () => {
  it('notifies when a session finishes', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });

    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toContain('apfm-web');
  });

  it('says nothing about idle by default — the chatty class is off', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'idle' });

    expect(shown).toEqual([]);
  });

  it('notifies on idle once the user turns it on', () => {
    const { notifier, shown } = harness({ sessionIdle: true });

    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'idle' });

    expect(shown).toHaveLength(1);
  });

  it('never notifies for working — it is not an event class', () => {
    const { notifier, shown } = harness({ sessionIdle: true });

    notifier.observe(CH.sessionStatus, {
      entityId: 'apfm-web',
      status: 'working',
    });

    expect(shown).toEqual([]);
  });

  it('respects a class the user switched off', () => {
    const { notifier, shown } = harness({ sessionDone: false });

    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });

    expect(shown).toEqual([]);
  });

  it('reads the preference at the moment of the event, not at construction', () => {
    // The prefs callback exists so a save takes effect without rebuilding the
    // notifier — a snapshot captured at boot would ignore every later change.
    let prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATIONS };
    const shown: Shown[] = [];
    const notifier = createNotifier({
      prefs: () => prefs,
      present: (options) => shown.push(options),
      activate: () => undefined,
    });

    prefs = { ...prefs, sessionDone: false };
    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });

    expect(shown).toEqual([]);
  });
});

describe('clones', () => {
  it('notifies when a clone succeeds', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.configCloneDone, cloneEvent(true));

    expect(shown).toHaveLength(1);
  });

  it('notifies when a clone fails — a failure is what you walked away from', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.configCloneDone, cloneEvent(false));

    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toContain('authentication failed');
  });

  it('respects the clone class being switched off', () => {
    const { notifier, shown } = harness({ cloneDone: false });

    notifier.observe(CH.configCloneDone, cloneEvent(true));

    expect(shown).toEqual([]);
  });

  it('does not offer to open anything — a clone is not a session', () => {
    const { notifier, shown, activated } = harness();

    notifier.observe(CH.configCloneDone, cloneEvent(true));
    shown[0]?.onClick();

    expect(activated).toEqual([]);
  });
});

describe('clicking', () => {
  it('asks the renderer to open the session the notification was about', () => {
    const { notifier, shown, activated } = harness();

    notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });
    shown[0]?.onClick();

    expect(activated).toEqual(['apfm-web']);
  });
});

describe('other channels and bad payloads', () => {
  it('ignores channels that are not an event class', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.ptyData, { sessionId: 'a', chunk: 'x' });
    notifier.observe(CH.ptyExit, { sessionId: 'a', code: 0 });

    expect(shown).toEqual([]);
  });

  it('ignores a payload that is not the shape it expects', () => {
    const { notifier, shown } = harness();

    notifier.observe(CH.sessionStatus, null);
    notifier.observe(CH.sessionStatus, 'done');
    notifier.observe(CH.sessionStatus, { entityId: 42, status: 'done' });
    notifier.observe(CH.sessionStatus, { entityId: 'a' });
    notifier.observe(CH.configCloneDone, { ok: 'yes' });

    expect(shown).toEqual([]);
  });

  it('never throws — the broadcast it taps must not be broken by it', () => {
    const notifier = createNotifier({
      prefs: () => {
        throw new Error('config exploded');
      },
      present: () => undefined,
      activate: () => undefined,
    });

    expect(() =>
      notifier.observe(CH.sessionStatus, { entityId: 'a', status: 'done' }),
    ).not.toThrow();
  });
});
