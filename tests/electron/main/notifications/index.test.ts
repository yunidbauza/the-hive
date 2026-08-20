// @vitest-environment node
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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

const notifier = () => createNotifier({ hub, isForeground: () => false });

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

/**
 * The gap the `Notification` subscription closes.
 *
 * Measured against Claude Code 2.1.227 in a real pty: a turn ends with `Stop`,
 * and sixty seconds later — if nobody has typed — `Notification` arrives with
 * `notification_type: "idle_prompt"`. Nothing else reports it, and before this
 * the app raised nothing at all for the commonest way a session waits on a
 * human.
 */
describe('the Notification hook', () => {
  const waiting = (
    entityId: string,
    notificationType: string,
  ): Parameters<ReturnType<typeof notifier>['observe']>[1] => ({
    entityId,
    status: 'waiting',
    event: 'Notification',
    notificationType,
  });

  it('raises session.input_needed for an idle prompt', () => {
    notifier().observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));

    expect(raised().kind).toBe('session.input_needed');
    expect(raised().title).toBe('lead-form is waiting on you');
    expect(raised().action).toEqual({ type: 'session', entityId: 'lead-form' });
  });

  /**
   * It arrives about six seconds behind the `PermissionRequest` that already
   * said so. Two rows, two glyphs, one interruption.
   */
  it('raises nothing for a permission prompt — PermissionRequest already did', () => {
    notifier().observe(
      CH.sessionStatus,
      waiting('lead-form', 'permission_prompt'),
    );

    expect(raise).not.toHaveBeenCalled();
  });

  it('ignores a notification type this build has no reading of', () => {
    notifier().observe(CH.sessionStatus, waiting('lead-form', 'auth_needed'));

    expect(raise).not.toHaveBeenCalled();
  });

  /**
   * Both lookups are object literals indexed by a string off an IPC payload, so
   * a bare index walks the prototype: `'constructor'` answers with an inherited
   * *function*, which passes the `=== undefined` guard and then throws when the
   * copy table has no entry for it. `observe`'s try swallows that, so the cost
   * is one silently dropped notification — the kind of fault nobody reports.
   *
   * Unreachable through the receiver, which validates the closed vocabulary
   * first. Asserted anyway: that validation is one refactor away from moving,
   * and `waitingKind` advertises that it copes with `unknown`.
   */
  it.each(['constructor', 'toString', '__proto__', 'valueOf'])(
    'treats the inherited property %s as no kind at all',
    (notificationType) => {
      const n = notifier();

      n.observe(CH.sessionStatus, waiting('lead-form', notificationType));
      n.observe(CH.sessionStatus, {
        entityId: 'lead-form',
        status: 'waiting',
        event: notificationType,
      });

      expect(raise).not.toHaveBeenCalled();
    },
  );

  it('ignores a Notification carrying no type at all', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'waiting',
      event: 'Notification',
    });

    expect(raise).not.toHaveBeenCalled();
  });

  /**
   * Claude may repeat `idle_prompt` for a session left alone, and every repeat
   * is a genuinely new event at a new time — so the hub's id dedup cannot see
   * it. Said once per stretch of waiting, or the inbox fills with one fact.
   */
  it('says it once while the session stays waiting', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));
    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));
    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));

    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('says it again once the session has visibly stopped waiting', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));
    // The user came back and typed.
    n.observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));

    expect(raise).toHaveBeenCalledTimes(2);
  });

  /** The suppression is per session, not global. */
  it('does not let one waiting session silence another', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, waiting('lead-form', 'idle_prompt'));
    n.observe(CH.sessionStatus, waiting('call-notes', 'idle_prompt'));

    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise.mock.calls[1][0].title).toBe('call-notes is waiting on you');
  });
});

/**
 * HIVE-81: `idle_prompt` now reports the status `idle`, not `waiting` — see
 * `hook-contract.ts`'s `NOTIFICATION_TYPE_STATUS`. The inbox row it raises is
 * routed off the hook *event*, independently of that status, which is the
 * split these tests pin down.
 */
describe('idle_prompt', () => {
  it('raises session.input_needed even though the status is idle', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    });

    expect(raised().kind).toBe('session.input_needed');
  });

  it('announces once across repeats, and again after the user engages', () => {
    const n = notifier();
    const idlePrompt = {
      entityId: 'sess-03',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    };

    n.observe(CH.sessionStatus, idlePrompt);
    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);

    // A plain hook-driven idle must NOT re-arm it — only engagement does.
    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'idle',
      event: 'Stop',
    });
    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);

    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('still raises nothing for Stop', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'idle',
      event: 'Stop',
    });

    expect(raise).not.toHaveBeenCalled();
  });

  it('still raises session.idle for a pty-derived idle', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, { entityId: 'sess-03', status: 'idle' });

    expect(raised().kind).toBe('session.idle');
  });
});

/**
 * HIVE-81: two defects seen in the running app.
 *
 * A — the title interpolated the internal entity id (`sess-01`) instead of the
 * name the rest of the UI shows for that session (`INCORP-478`), so a
 * notification could not be connected back to the session it was about.
 *
 * B — `announcedInputNeeded` cleared on `working`, and `PostToolUse` maps to
 * `working` per tool call, so a backgrounded agent running tools re-armed the
 * mark and the same "is waiting on you" row was announced repeatedly while
 * nothing was actually waiting on the user.
 */
describe('naming', () => {
  it('uses the session display name once one is known', () => {
    const n = notifier();

    n.observe(CH.sessionName, { entityId: 'sess-01', name: 'INCORP-478' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'INCORP-478 needs approval' }),
    );
  });

  it('falls back to the entity id before any rename arrives', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'sess-01 needs approval' }),
    );
  });

  it('follows a later rename', () => {
    const n = notifier();

    n.observe(CH.sessionName, { entityId: 'sess-01', name: 'INCORP-478' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });
    expect(raised().title).toBe('INCORP-478 needs approval');

    raise.mockClear();

    n.observe(CH.sessionName, { entityId: 'sess-01', name: 'INCORP-999' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'Elicitation',
    });
    expect(raised().title).toBe('INCORP-999 asked a question');
  });

  it('names the session in an idle and an ended body too', () => {
    const n = notifier();

    n.observe(CH.sessionName, { entityId: 'sess-01', name: 'INCORP-478' });

    n.observe(CH.sessionStatus, { entityId: 'sess-01', status: 'idle' });
    expect(raised().body).toBe('INCORP-478 has gone quiet.');

    raise.mockClear();

    n.observe(CH.sessionStatus, { entityId: 'sess-01', status: 'terminated' });
    expect(raised().body).toBe('INCORP-478 has exited.');
  });

  it('keeps the raw entityId in the action even once a name is known', () => {
    const n = notifier();

    n.observe(CH.sessionName, { entityId: 'sess-01', name: 'INCORP-478' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raised().action).toEqual({ type: 'session', entityId: 'sess-01' });
  });

  it('ignores a malformed rename payload', () => {
    const n = notifier();

    n.observe(CH.sessionName, { entityId: 'sess-01' });
    n.observe(CH.sessionName, { name: 'INCORP-478' });
    n.observe(CH.sessionName, { entityId: 'sess-01', name: 42 });

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raised().title).toBe('sess-01 needs approval');
  });
});

describe('announced once', () => {
  it('does not re-announce because a tool finished', () => {
    const n = notifier();
    const idlePrompt = {
      entityId: 'sess-01',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    };

    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);

    // A backgrounded agent running tools. Not the user coming back.
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'working',
      event: 'PostToolUse',
    });
    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('re-announces after the user submits a prompt', () => {
    const n = notifier();
    const idlePrompt = {
      entityId: 'sess-01',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    };

    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('re-announces after the session terminates and a new one starts', () => {
    const n = notifier();
    const idlePrompt = {
      entityId: 'sess-01',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    };

    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(1);

    // A pty-derived `terminated` carries no hook event, so it raises its own
    // session.ended notification on the way through — that is pre-existing,
    // unrelated behaviour. What this test pins down is that it also clears
    // the mark, so a new session reusing the id can be announced again.
    n.observe(CH.sessionStatus, { entityId: 'sess-01', status: 'terminated' });
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise.mock.calls[1][0].kind).toBe('session.ended');

    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(3);
    expect(raise.mock.calls[2][0].kind).toBe('session.input_needed');
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

/**
 * HIVE-81, the other half of the foreground gate: a session that blocked
 * silently while the user was watching it must speak up once they look away.
 *
 * `pendingForeground` is keyed on the session, so these exercise it through
 * `sessionEvent`'s waiting branch and `reevaluateForeground` rather than
 * reaching into the map directly.
 */
describe('foreground re-arm', () => {
  let promote: ReturnType<typeof vi.fn>;
  let isForeground: Mock<(entityId: string) => boolean>;

  const waitingPermission = (entityId: string) => ({
    entityId,
    status: 'waiting',
    event: 'PermissionRequest',
  });

  beforeEach(() => {
    // Succeeds by default; the failure case overrides per-call below.
    promote = vi.fn(() => true);
    isForeground = vi.fn(() => false);
    hub = {
      raise,
      list: () => [],
      markRead: () => undefined,
      clear: () => undefined,
      promote,
    } as unknown as NotificationHub;
  });

  const makeNotifier = () => createNotifier({ hub, isForeground });

  it('promotes a still-waiting session when it leaves the foreground', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledWith('raised-1');
  });

  /**
   * The bug a review of this branch caught, and the reason `pendingForeground`
   * stopped keying its relevance off the status.
   *
   * `idle_prompt` reports `idle`, not `waiting` (Part 3.1), so the old
   * `status === 'waiting'` condition recorded nothing for it — while
   * `announcedInputNeeded` had already been spent. The row was raised
   * already-read, no toast and no badge, and nothing could ever promote it: the
   * user was told about a blocked session by a row they never saw and a badge
   * that never moved.
   */
  const idlePrompt = (entityId: string) => ({
    entityId,
    status: 'idle',
    event: 'Notification',
    notificationType: 'idle_prompt',
  });

  it('promotes a gated input_needed when the user looks away', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    n.reevaluateForeground();

    expect(raise).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith('raised-1');
  });

  it('promotes nothing when the user types instead of looking away', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-04',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();

    // The same engagement cleared the announce-once mark, so the *next* time
    // the session runs out of instructions it announces again.
    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    expect(raise).toHaveBeenCalledTimes(2);
  });

  /**
   * The half of the relevance rule that a status test cannot express: a
   * backgrounded agent runs tools, every tool reports `working`, and none of
   * that is the user coming back. The gated row must still be there to promote.
   */
  it('keeps a gated input_needed pending while a background agent works', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-04',
      status: 'working',
      event: 'PostToolUse',
    });
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledWith('raised-1');
  });

  it('raises one row for a repeating idle prompt, and promotes that one row', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    isForeground.mockReturnValue(true);
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    // Still watching: nothing to promote, and the repeat must not raise a
    // second row on top of the one already sitting read in the inbox.
    n.reevaluateForeground();
    n.observe(CH.sessionStatus, idlePrompt('sess-04'));

    expect(raise).toHaveBeenCalledTimes(1);
    expect(promote).not.toHaveBeenCalled();

    isForeground.mockReturnValue(false);
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith('raised-1');
  });

  it('drops a gated input_needed when the session terminates', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    n.observe(CH.sessionStatus, { entityId: 'sess-04', status: 'terminated' });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  /**
   * The parallel-tool bug, and the reason a blocked kind no longer expires on
   * `PostToolUse`.
   *
   * Claude routinely runs tools in a batch. Tool B asks for permission — the
   * row is raised gated and recorded pending — and then tool A, a *sibling* in
   * the same batch, completes and reports `working`. Tool B's permission is
   * still outstanding, and nothing will ever re-record the entry:
   * `Notification/permission_prompt` maps to `undefined` by design, so it
   * never raises. Expiring on the sibling's completion is a session that is
   * blocked and silent.
   */
  it('keeps a gated permission pending when a sibling tool finishes', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'working',
      event: 'PostToolUse',
    });
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledWith('raised-1');
  });

  it('drops a gated permission when the user submits a prompt', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  /** The turn ended, so nothing in it can still be blocked on an answer. */
  it('drops a gated permission when the turn ends', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'idle',
      event: 'Stop',
    });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  it('drops a gated permission when the session terminates', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.observe(CH.sessionStatus, { entityId: 'sess-03', status: 'terminated' });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  /**
   * Was written against `PostToolUse` — the very path that turned out to be a
   * sibling's completion rather than proof of an answer. A pty-derived status
   * change carries no hook event, so it is a status leaving `waiting` by a
   * route that says nothing about a batch of tools, and it still expires.
   */
  it('promotes nothing when the session stopped waiting on its own', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.observe(CH.sessionStatus, { entityId: 'sess-03', status: 'working' });

    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  it('promotes nothing for a session that was never foreground', () => {
    // Never gated at raise time: unread stayed true, so nothing was recorded
    // as pending.
    raise.mockReturnValue({ id: 'raised-1', unread: true });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  it('drops the pending entry once promoted, so a second blur does nothing', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.reevaluateForeground();
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(1);
  });

  /**
   * `hub.promote` answers `false` when a collaborator threw partway through
   * (the hub's own robustness test in `hub.test.ts` covers that case). This
   * is the fix for the bug a code review caught: `reevaluateForeground` used
   * to delete the pending entry *before* calling `hub.promote`, so a throw
   * inside `promote` — caught two layers up, by `notifyForegroundChange`'s
   * own try/catch — still left the session un-rearmed for good, on this or
   * any later focus change.
   */
  it('leaves the pending entry when promote fails, and promotes it on a later, successful call', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    promote.mockReturnValueOnce(false);
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(1);

    // Still pending — a second blur (or the same one, retried) tries again,
    // and this time the collaborator behaves.
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(2);

    // Promoted now — a third blur has nothing left to do, so `promote` is
    // not called again.
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(2);
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
