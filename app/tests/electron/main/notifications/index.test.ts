// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNotifier } from '../../../../electron/main/notifications';
import type { NotificationHub } from '../../../../electron/main/notifications/hub';
import { CH } from '../../../../electron/shared/ipc-contract';

/**
 * Which broadcasts become notifications (story 106, rewritten by HIVE-75).
 *
 * The notifier no longer presents anything — it translates a channel and a
 * payload into a *kind*, and the hub decides the rest. So these tests assert on
 * what was raised, and the hub's own tests cover whether it was delivered.
 */

let raise: ReturnType<typeof vi.fn>;
let hub: NotificationHub;

beforeEach(() => {
  raise = vi.fn(() => null);
  hub = {
    raise,
    list: () => [],
    markRead: () => undefined,
    clear: () => undefined,
  } as unknown as NotificationHub;
});

const notifier = () => createNotifier({ hub });

const raised = () => raise.mock.calls[0][0] as Record<string, unknown>;

describe('session status', () => {
  it('raises session.ended when a process exits', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'terminated',
    });

    expect(raised().kind).toBe('session.ended');
    expect(raised().title).toBe('Session ended');
    expect(raised().action).toEqual({ type: 'session', entityId: 'lead-form' });
  });

  it('raises session.idle when a session goes quiet', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'idle',
    });

    expect(raised().kind).toBe('session.idle');
  });

  /**
   * `HOOK_STATUS` maps both `SessionStart` and `Stop` to `idle`, so without the
   * gate every spawn announced "has gone quiet" the moment it started, and
   * every turn announced it again — filling the buffer and evicting the
   * approval request the user actually walked away from.
   */
  it('raises nothing for a hook-driven idle — that is not going quiet', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'apfm-web',
      status: 'idle',
      event: 'SessionStart',
    });
    n.observe(CH.sessionStatus, {
      entityId: 'apfm-web',
      status: 'idle',
      event: 'Stop',
    });

    expect(raise).not.toHaveBeenCalled();
  });

  it('raises nothing for working — it is not an event class', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'working',
    });

    expect(raise).not.toHaveBeenCalled();
  });

  /**
   * The distinction HIVE-75 exists to make. Both hooks mean `waiting`; they do
   * not mean the same thing to the person being asked.
   */
  it('tells a permission request apart from an elicitation', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'waiting',
      event: 'PermissionRequest',
    });
    expect(raised().kind).toBe('session.waiting');
    expect(raised().title).toBe('lead-form needs approval');

    raise.mockClear();

    n.observe(CH.sessionStatus, {
      entityId: 'call-notes',
      status: 'waiting',
      event: 'Elicitation',
    });
    expect(raised().kind).toBe('session.asked');
    expect(raised().title).toBe('call-notes asked a question');
  });

  /** Guessing would describe a different question than the one being asked. */
  it('drops a waiting that names no hook rather than guessing', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'waiting',
    });

    expect(raise).not.toHaveBeenCalled();
  });
});

describe('clone', () => {
  it('raises clone.done on success, with nowhere to go', () => {
    notifier().observe(CH.configCloneDone, { ok: true });

    expect(raised().kind).toBe('clone.done');
    expect(raised().title).toBe('Clone finished');
    expect(raised().action).toEqual({ type: 'none' });
  });

  it('carries the reason on a failure', () => {
    notifier().observe(CH.configCloneDone, {
      ok: false,
      reason: 'authentication failed',
    });

    expect(raised().title).toBe('Clone failed');
    expect(raised().body).toBe('authentication failed');
  });
});

describe('everything else', () => {
  it('ignores channels that are not event classes', () => {
    notifier().observe(CH.ptyData, { sessionId: 's1', data: 'hello' });
    expect(raise).not.toHaveBeenCalled();
  });

  it('ignores a payload that is not a record', () => {
    notifier().observe(CH.sessionStatus, 'nonsense');
    expect(raise).not.toHaveBeenCalled();
  });

  it('ignores a malformed payload rather than raising a nameless notification', () => {
    notifier().observe(CH.sessionStatus, { status: 'terminated' });
    expect(raise).not.toHaveBeenCalled();
  });

  /** A failed notification must never cost a `pty:data`. */
  it('never throws, whatever the hub does', () => {
    raise.mockImplementation(() => {
      throw new Error('hub exploded');
    });

    expect(() =>
      notifier().observe(CH.sessionStatus, {
        entityId: 'lead-form',
        status: 'terminated',
      }),
    ).not.toThrow();
  });
});
