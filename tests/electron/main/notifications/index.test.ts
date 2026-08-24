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
  /**
   * `session.ended` was retired (HIVE-83): `/exit` is deliberate and the fleet
   * view already shows the row, so a pty-derived `terminated` — no hook event —
   * now raises nothing at all.
   */
  it('raises nothing when a process exits — pty-derived, no event', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'terminated',
    });

    expect(raise).not.toHaveBeenCalled();
  });

  /**
   * `session.idle` was retired (HIVE-83): it was reachable only on this
   * pty-derived path, and the `hookDriven` gate blocked it for every session
   * that ever sent a hook — so it never fired for a Claude session anyway.
   */
  it('raises nothing when a session goes quiet — pty-derived, no event', () => {
    notifier().observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'idle',
    });

    expect(raise).not.toHaveBeenCalled();
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
   * HIVE-83: both hooks now raise the same `session.blocked` kind — the
   * distinction survives in the row's words, not in a second switch.
   */
  it('tells a permission request apart from an elicitation, in the copy', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'waiting',
      event: 'PermissionRequest',
    });
    expect(raised().kind).toBe('session.blocked');
    expect(raised().title).toBe('lead-form needs approval');

    raise.mockClear();

    n.observe(CH.sessionStatus, {
      entityId: 'call-notes',
      status: 'waiting',
      event: 'Elicitation',
    });
    expect(raised().kind).toBe('session.blocked');
    expect(raised().title).toBe('call-notes needs an answer');
  });

  /** The real question case: `AskUserQuestion` arrives as a `PermissionRequest`. */
  it('tells AskUserQuestion apart from any other tool waiting on a yes', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'lead-form',
      status: 'waiting',
      event: 'PermissionRequest',
      toolName: 'AskUserQuestion',
    });

    expect(raised().kind).toBe('session.blocked');
    expect(raised().title).toBe('lead-form asked a question');
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

  /** `session.idle` is retired (HIVE-83); a pty-derived idle now raises nothing. */
  it('still raises nothing for a pty-derived idle', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, { entityId: 'sess-03', status: 'idle' });

    expect(raise).not.toHaveBeenCalled();
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
    expect(raised().title).toBe('INCORP-999 needs an answer');
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

    // A pty-derived `terminated` carries no hook event, so it raises nothing
    // of its own (HIVE-83 retired `session.ended`). What this test pins down
    // is that it still clears the mark, so a new session reusing the id can
    // be announced again.
    n.observe(CH.sessionStatus, { entityId: 'sess-01', status: 'terminated' });
    expect(raise).toHaveBeenCalledTimes(1);

    n.observe(CH.sessionStatus, idlePrompt);
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise.mock.calls[1][0].kind).toBe('session.input_needed');
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

  it('promotes nothing when the session finished with /done (HIVE-93)', () => {
    /*
      A declared finish does **not** reach the status channel — it leaves on
      `session:finished`, and the `terminated` that `activity.ts` observes a
      moment later is deliberately suppressed. So without a branch for it here
      the notifier never learns the session ended: the pending row survives, and
      the next foreground change promotes it into a toast saying a finished
      session is waiting on the user, whose click opens a session that is gone.
    */
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    n.observe(CH.sessionFinished, { entityId: 'sess-04', resumable: true });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
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
   * The parallel-tool bug, fixed at the source now (HIVE-83).
   *
   * Claude routinely runs tools in a batch. Tool B asks for permission — the
   * row is raised gated and recorded pending — and then tool A, a *sibling* in
   * the same batch, completes. The tracker pairs tool events by
   * `tool_use_id`, so the sibling's `PostToolUse` does not resolve tool B's
   * still-open request: the status the tracker reports stays `waiting`, and
   * `stillRelevant`'s plain `status === 'waiting'` test — no special case for
   * `PostToolUse` any more — is enough to keep the pending row alive.
   */
  it('keeps a gated permission pending when a sibling tool finishes', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    const n = makeNotifier();

    n.observe(CH.sessionStatus, waitingPermission('sess-03'));
    // The sibling's completion, as the tracker would actually report it: tool
    // B's `PermissionRequest` is still outstanding, so status stays `waiting`.
    n.observe(CH.sessionStatus, {
      entityId: 'sess-03',
      status: 'waiting',
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

/**
 * HIVE-89: the notification for the idle that actually means "your turn is
 * over, come back" — idle with **nothing left running**.
 *
 * An edge, not a level. The notifier arms a session on `UserPromptSubmit` and
 * spends the arm on the first `Stop` that lands `idle` with no `idleDetail`.
 * The ticket named three ways to reach the moment — `Stop`, a `SubagentStop`
 * that retires the last agent, and the last background shell finishing — and
 * the live run showed the last two both arrive as a `Stop`: Claude Code
 * collects a subagent's result and a finished shell's output alike through an
 * internal re-invoke (`UserPromptSubmit`) that ends in a `Stop`. Raising at
 * `SubagentStop` as well was two rows for one fact, so it does not spend the
 * arm. `terminated` disarms, and a session that never typed (a `SessionStart`
 * idle, a resumed conversation) is never armed in the first place.
 */
describe('session.idle', () => {
  const prompt = (entityId: string) => ({
    entityId,
    status: 'working',
    event: 'UserPromptSubmit',
  });
  const stop = (entityId: string, idleDetail?: string) => ({
    entityId,
    status: 'idle',
    event: 'Stop',
    ...(idleDetail === undefined ? {} : { idleDetail }),
  });
  const idleKinds = () =>
    raise.mock.calls
      .map((call) => (call[0] as Record<string, unknown>).kind)
      .filter((kind) => kind === 'session.idle');

  it('raises once when Stop lands a true idle after a prompt', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(raised().kind).toBe('session.idle');
    expect(raised().title).toBe('sess-05 is yours again');
    expect(raised().action).toEqual({ type: 'session', entityId: 'sess-05' });
  });

  it('raises nothing while a background agent is still running', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05', 'agents'));

    expect(raise).not.toHaveBeenCalled();
  });

  it('raises nothing while a background shell is still running', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05', 'script'));

    expect(raise).not.toHaveBeenCalled();
  });

  /**
   * Measured (`tests/live/hook-conformance`): `Stop` idle/agents ->
   * `SubagentStop` idle -> internal `UserPromptSubmit` -> `Stop` idle. The
   * row lands once, on that last `Stop`, not at `SubagentStop`.
   */
  it('raises once when the last subagent finishes after the turn ended', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05', 'agents'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-05',
      status: 'idle',
      event: 'SubagentStop',
    });
    expect(raise).not.toHaveBeenCalled();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));
    expect(idleKinds()).toHaveLength(1);

    // The phantom `SubagentStop`s Claude Code emits afterwards change nothing.
    n.observe(CH.sessionStatus, {
      entityId: 'sess-05',
      status: 'idle',
      event: 'SubagentStop',
    });
    expect(idleKinds()).toHaveLength(1);
  });

  /**
   * Claude Code emits no hook when a backgrounded shell dies; its end is only
   * observable as the re-invoke that collects the result — a
   * `UserPromptSubmit` that clears `bgShells` — and the `Stop` that follows.
   * The arm is what makes that `Stop` the one that announces.
   */
  it('raises when the last background shell finishes after the turn ended', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05', 'script'));
    expect(raise).not.toHaveBeenCalled();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(idleKinds()).toHaveLength(1);
  });

  it('announces once per stretch — an idle → working → idle flicker is one row', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));
    n.observe(CH.sessionStatus, {
      entityId: 'sess-05',
      status: 'working',
      event: 'PostToolUse',
    });
    n.observe(CH.sessionStatus, stop('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(idleKinds()).toHaveLength(1);
  });

  it('re-arms on engagement and announces the next stretch', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));
    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(idleKinds()).toHaveLength(2);
  });

  it('never announces for a session that has not typed — SessionStart is not a turn', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-05',
      status: 'idle',
      event: 'SessionStart',
    });
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(raise).not.toHaveBeenCalled();
  });

  it('disarms on terminated, so the next session in the terminal must type first', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, { entityId: 'sess-05', status: 'terminated' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-05',
      status: 'idle',
      event: 'SessionStart',
    });
    n.observe(CH.sessionStatus, stop('sess-05'));

    expect(raise).not.toHaveBeenCalled();
  });

  it('does not spend the arm on a pty-derived idle', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, { entityId: 'sess-05', status: 'idle' });
    expect(raise).not.toHaveBeenCalled();

    n.observe(CH.sessionStatus, stop('sess-05'));
    expect(idleKinds()).toHaveLength(1);
  });

  it('keeps one session\'s arm separate from another\'s', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, prompt('sess-05'));
    n.observe(CH.sessionStatus, stop('sess-06'));
    expect(raise).not.toHaveBeenCalled();

    n.observe(CH.sessionStatus, stop('sess-05'));
    expect(idleKinds()).toHaveLength(1);
  });
});

/**
 * HIVE-89: `session.input_needed` is gated on `idleDetail`. It keeps its
 * meaning — sixty seconds passed and nothing was typed — and stops firing
 * while a background agent or script is still working, which was a false
 * positive regardless of `session.idle`.
 */
describe('input_needed under a live idle detail', () => {
  const idlePrompt = (idleDetail?: string) => ({
    entityId: 'sess-07',
    status: 'idle',
    event: 'Notification',
    notificationType: 'idle_prompt',
    ...(idleDetail === undefined ? {} : { idleDetail }),
  });

  it('raises nothing while a background agent is running', () => {
    notifier().observe(CH.sessionStatus, idlePrompt('agents'));
    expect(raise).not.toHaveBeenCalled();
  });

  it('raises nothing while a background shell is running', () => {
    notifier().observe(CH.sessionStatus, idlePrompt('script'));
    expect(raise).not.toHaveBeenCalled();
  });

  /** A suppressed prompt must not spend the once-per-stretch mark. */
  it('still raises the first true idle prompt after a suppressed one', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, idlePrompt('agents'));
    n.observe(CH.sessionStatus, idlePrompt());

    expect(raise).toHaveBeenCalledTimes(1);
    expect(raised().kind).toBe('session.input_needed');
  });
});

/**
 * HIVE-89: a `session.idle` raised while the user was watching is gated like
 * an `input_needed`, and promoted by the same rule when they look away.
 */
describe('session.idle foreground gating', () => {
  const gatedHub = () => {
    const promote = vi.fn(() => true);
    hub = {
      raise: raise.mockReturnValue({ id: 'raised-idle', unread: false }),
      list: () => [],
      markRead: () => undefined,
      clear: () => undefined,
      promote,
    } as unknown as NotificationHub;
    return promote;
  };
  const prompt = { entityId: 'sess-08', status: 'working', event: 'UserPromptSubmit' };
  const stop = { entityId: 'sess-08', status: 'idle', event: 'Stop' };

  /**
   * The nudge a minute later is the same fact again, and it is inbox-only
   * where the moment toasts. The first pending row stays the one promoted.
   */
  it('does not let a later gated input_needed evict the gated idle row', () => {
    const promote = gatedHub();
    const n = createNotifier({ hub, isForeground: () => false });

    n.observe(CH.sessionStatus, prompt);
    n.observe(CH.sessionStatus, stop);
    raise.mockReturnValue({ id: 'raised-nudge', unread: false });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-08',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    });
    n.reevaluateForeground();

    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith('raised-idle');
  });

  /** A toast saying "is yours again" about a session back at work would be a lie. */
  it('drops a gated idle row once the session is no longer idle', () => {
    const promote = gatedHub();
    const n = createNotifier({ hub, isForeground: () => false });

    n.observe(CH.sessionStatus, prompt);
    n.observe(CH.sessionStatus, stop);
    n.observe(CH.sessionStatus, {
      entityId: 'sess-08',
      status: 'working',
      event: 'PreToolUse',
    });
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  it('promotes a gated session.idle when the user looks away, and drops it on engagement', () => {
    const promote = vi.fn(() => true);
    hub = {
      raise: raise.mockReturnValue({ id: 'raised-idle', unread: false }),
      list: () => [],
      markRead: () => undefined,
      clear: () => undefined,
      promote,
    } as unknown as NotificationHub;
    const n = createNotifier({ hub, isForeground: () => false });

    n.observe(CH.sessionStatus, {
      entityId: 'sess-08',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.observe(CH.sessionStatus, { entityId: 'sess-08', status: 'idle', event: 'Stop' });
    n.reevaluateForeground();
    expect(promote).toHaveBeenCalledWith('raised-idle');

    promote.mockClear();
    n.observe(CH.sessionStatus, {
      entityId: 'sess-08',
      status: 'working',
      event: 'UserPromptSubmit',
    });
    n.reevaluateForeground();
    expect(promote).not.toHaveBeenCalled();
  });
});
