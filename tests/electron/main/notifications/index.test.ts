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
    dismissForeground: () => undefined,
    dismissForSession: () => undefined,
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
      entityId: 'nova-web',
      status: 'idle',
      event: 'SessionStart',
    });
    n.observe(CH.sessionStatus, {
      entityId: 'nova-web',
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
    expect(raised().title).toBe('needs approval');

    raise.mockClear();

    n.observe(CH.sessionStatus, {
      entityId: 'call-notes',
      status: 'waiting',
      event: 'Elicitation',
    });
    expect(raised().kind).toBe('session.blocked');
    expect(raised().title).toBe('needs an answer');
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
    expect(raised().title).toBe('asked a question');
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
    expect(raised().title).toBe('is waiting on you');
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
    expect(raise.mock.calls[1][0].title).toBe('is waiting on you');
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
  /*
    HIVE-110. The notifier used to keep its own map of names and paste one in
    front of every title. It no longer holds a name at all: it raises the
    predicate and the terminal, and whoever renders the row decides what to call
    the session at the moment they render it. These assert that seam, because it
    is the thing that stops a row saying `sess-11` about a session the rail has
    since titled.
  */
  it('raises the predicate alone, with the terminal as the subject', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'needs approval', subject: 'sess-01' }),
    );
  });

  it('never pastes a name in, whatever the terminal reported', () => {
    const n = notifier();

    // The raw OSC title, which is what this channel carries and what the
    // notifier used to mistake for the name the rail shows.
    n.observe(CH.sessionName, { entityId: 'sess-01', name: '\u2733 Claude Code' });
    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raised().title).toBe('needs approval');
    expect(raised().subject).toBe('sess-01');
  });

  it('subjects every session kind, and only session kinds', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'Elicitation',
    });
    expect(raised()).toMatchObject({
      title: 'needs an answer',
      subject: 'sess-01',
    });

    raise.mockClear();

    n.observe(CH.configCloneDone, { ok: true });
    expect(raised().title).toBe('Clone finished');
    expect(raised().subject).toBeUndefined();
  });

  it('keeps the raw entityId in the action as well as the subject', () => {
    const n = notifier();

    n.observe(CH.sessionStatus, {
      entityId: 'sess-01',
      status: 'waiting',
      event: 'PermissionRequest',
    });

    expect(raised().action).toEqual({ type: 'session', entityId: 'sess-01' });
    expect(raised().subject).toBe('sess-01');
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
      dismissForeground: () => undefined,
      dismissForSession: () => undefined,
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

  /**
   * The half of this that the arrival sweep changed, and deliberately.
   *
   * It used to end by promoting the gated row when the user looked away. That
   * was right while a gated row was only ever *deferred*: the user had not
   * acted, so the announcement was still owed. Now that being at the session
   * is itself the answer for an `input_needed`, a re-evaluation that finds the
   * session **still in front of the user** sweeps the row instead of banking
   * it — so looking away later has nothing left to promote.
   *
   * What is unchanged, and is the other half of the assertion: a repeat raises
   * no second row. That rule is `announcedInputNeeded`'s and is untouched.
   *
   * The ordinary "raised while watching, then walked away" path still toasts,
   * and is covered below — the sweep runs first in `reevaluateForeground`, and
   * by then the session is no longer foreground, so it takes nothing.
   */
  it('raises one row for a repeating idle prompt, and clears it on arrival', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    isForeground.mockReturnValue(true);
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));
    // Still watching: the row is swept rather than promoted, and the repeat
    // must not raise a second one on top of the one already dealt with.
    n.reevaluateForeground();
    n.observe(CH.sessionStatus, idlePrompt('sess-04'));

    expect(raise).toHaveBeenCalledTimes(1);
    expect(promote).not.toHaveBeenCalled();

    isForeground.mockReturnValue(false);
    n.reevaluateForeground();

    expect(promote).not.toHaveBeenCalled();
  });

  /**
   * The path the sweep must not eat: gated because the user was watching, then
   * they leave without the session having been answered. `reevaluateForeground`
   * sweeps first, but the session is background by then, so the promotion
   * stands and the toast fires. This is HIVE-81's whole purpose.
   */
  it('still promotes a gated row when the user leaves without coming back', () => {
    raise.mockReturnValue({ id: 'raised-1', unread: false });
    isForeground.mockReturnValue(true);
    const n = makeNotifier();

    n.observe(CH.sessionStatus, idlePrompt('sess-04'));

    isForeground.mockReturnValue(false);
    n.reevaluateForeground();

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
    expect(raised().title).toBe('is yours again');
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
      dismissForeground: () => undefined,
      dismissForSession: () => undefined,
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
      dismissForeground: () => undefined,
      dismissForSession: () => undefined,
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

/**
 * Rows that dismiss themselves, each on the signal that finishes its job.
 *
 * The inbox exists to route attention, and a row that has already been acted
 * on routes nothing — it is a chore. Two kinds of chore, and they are finished
 * by two different acts, which is why this is not one rule:
 *
 * - `session.idle` and `session.input_needed` both say *the session is yours,
 *   come back*. **Arriving is the answer.** The moment that terminal is on the
 *   user's screen the row has told them everything it exists to tell them, and
 *   `isForeground` is exactly "this terminal, in front of this user".
 * - `session.blocked` says *the session is stopped until you act*, and walking
 *   over to look at it does not act. It is finished by an **answer**, which is
 *   observable: the tracker holds `waiting` while `blocked` is non-empty
 *   (`tracker.ts`'s `derive`) and drops it when the tool's `PostToolUse`
 *   arrives with the same `tool_use_id` — an approved permission, an answered
 *   `AskUserQuestion` — or when the user types, which is a typed refusal. So
 *   "the session stopped being `waiting`" is the answer, and `stillRelevant`
 *   already spells it that way for the gated case.
 *
 * ## What this knowingly does not catch
 *
 * Two ways out of a block emit no hook at all, so neither can be observed here
 * and both leave the row until the next prompt:
 *
 * - **Escape.** Measured and recorded in `tracker.ts`: dismissing a permission
 *   prompt with Escape "emits no event whatsoever", which is why `blocked` is
 *   cleared wholesale by `UserPromptSubmit` in the first place.
 * - **An answered `Elicitation`.** Its block is held under the `UNPAIRED`
 *   sentinel with no tool name, so no `PostToolUse` can pair with it. The
 *   contract records that elicitation effectively never fires, so this costs
 *   nothing today.
 *
 * Inferring an answer from silence is the alternative, and it is worse: it
 * would clear rows about sessions that are genuinely still stopped, which is
 * the one failure that makes the inbox lie rather than merely nag.
 */
describe('a row dismisses itself once it has been acted on', () => {
  let dismissForeground: Mock<(kinds: readonly string[]) => void>;
  let dismissForSession: Mock<(entityId: string, kinds: readonly string[]) => void>;
  let foreground: string | null;

  const withSweeps = () => {
    dismissForeground = vi.fn();
    dismissForSession = vi.fn();
    hub = {
      raise: raise.mockReturnValue({ id: 'raised', unread: true }),
      list: () => [],
      markRead: () => undefined,
      clear: () => undefined,
      promote: vi.fn(() => true),
      dismissForeground,
      dismissForSession,
    } as unknown as NotificationHub;
    return createNotifier({
      hub,
      isForeground: (entityId) => entityId === foreground,
    });
  };

  beforeEach(() => {
    foreground = null;
  });

  describe('entering the session', () => {
    it('sweeps the two kinds that arriving answers, and only those', () => {
      const n = withSweeps();

      foreground = 'sess-05';
      n.reevaluateForeground();

      expect(dismissForeground).toHaveBeenCalledWith([
        'session.idle',
        'session.input_needed',
      ]);
    });

    /**
     * The hub is asked on every foreground change, not only when the notifier
     * happens to be holding a pending row: a row raised while the session was
     * in the background is live in the buffer and the notifier keeps no id for
     * it. Only the hub can see it, so only the hub can be asked.
     */
    it('asks even when the notifier is holding nothing pending', () => {
      const n = withSweeps();

      n.reevaluateForeground();

      expect(dismissForeground).toHaveBeenCalledTimes(1);
    });

    /**
     * The pending entry is the promotion's half of HIVE-81, and a promotion of
     * a row that has just been swept would be a toast about a session the user
     * is standing in. Dropped here, so looking away later promotes nothing.
     */
    it('forgets a pending idle row it has just had swept', () => {
      const promote = vi.fn(() => true);
      dismissForeground = vi.fn();
      dismissForSession = vi.fn();
      hub = {
        raise: raise.mockReturnValue({ id: 'raised-idle', unread: false }),
        list: () => [],
        markRead: () => undefined,
        clear: () => undefined,
        promote,
        dismissForeground,
        dismissForSession,
      } as unknown as NotificationHub;
      const n = createNotifier({
        hub,
        isForeground: (entityId) => entityId === foreground,
      });

      foreground = 'sess-05';
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'UserPromptSubmit',
      });
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'idle',
        event: 'Stop',
      });
      n.reevaluateForeground();

      foreground = null;
      n.reevaluateForeground();

      expect(promote).not.toHaveBeenCalled();
    });

    /** A pending block is not swept by arriving, so it must still promote. */
    it('keeps a pending blocked row, which arriving does not answer', () => {
      const promote = vi.fn(() => true);
      dismissForeground = vi.fn();
      dismissForSession = vi.fn();
      hub = {
        raise: raise.mockReturnValue({ id: 'raised-block', unread: false }),
        list: () => [],
        markRead: () => undefined,
        clear: () => undefined,
        promote,
        dismissForeground,
        dismissForSession,
      } as unknown as NotificationHub;
      const n = createNotifier({
        hub,
        isForeground: (entityId) => entityId === foreground,
      });

      foreground = 'sess-05';
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'waiting',
        event: 'PermissionRequest',
      });
      n.reevaluateForeground();

      foreground = null;
      n.reevaluateForeground();

      expect(promote).toHaveBeenCalledWith('raised-block');
    });
  });

  describe('answering the question', () => {
    const block = (entityId: string) => ({
      entityId,
      status: 'waiting',
      event: 'PermissionRequest',
    });

    /** An approved tool runs, and its `PostToolUse` lands `working`. */
    it('sweeps the blocked row when the tool the user approved completes', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'PostToolUse',
      });

      expect(dismissForSession).toHaveBeenCalledWith('sess-05', ['session.blocked']);
    });

    /** A typed refusal is a `UserPromptSubmit`, which clears `blocked` too. */
    it('sweeps the blocked row when the user types instead of approving', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'UserPromptSubmit',
      });

      expect(dismissForSession).toHaveBeenCalledWith('sess-05', ['session.blocked']);
    });

    it('sweeps a blocked row about a session that has ended', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionFinished, { entityId: 'sess-05' });

      expect(dismissForSession).toHaveBeenCalledWith('sess-05', ['session.blocked']);
    });

    it('sweeps nothing while the session is still blocked', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, block('sess-05'));

      expect(dismissForSession).not.toHaveBeenCalled();
    });

    /**
     * The mark is spent, not merely tested: a session that blocks, resolves,
     * and then reports a hundred more `working` events must ask the hub once.
     */
    it('asks once per block, not once per event after it', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'PostToolUse',
      });
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'idle',
        event: 'Stop',
      });

      expect(dismissForSession).toHaveBeenCalledTimes(1);
    });

    /**
     * The un-mark is guarded on the kind, and this is the run that needs it.
     *
     * An answered `Elicitation` leaves its block under `UNPAIRED` with no tool
     * name to pair against, so the tracker keeps reporting `waiting`. The
     * `idle_prompt` that follows raises `session.input_needed` — and a user who
     * has switched that kind off gets a `null` back. Unguarded, that `null`
     * wiped the mark belonging to a block that is still live, and the row
     * became unsweepable: the `UserPromptSubmit` that should have cleared it
     * would find nothing marked.
     */
    it('keeps the block mark when a different kind is the one refused', () => {
      dismissForeground = vi.fn();
      dismissForSession = vi.fn();
      // `session.blocked` raises a row; the `input_needed` behind it is off.
      raise.mockImplementation((input: { kind: string }) =>
        input.kind === 'session.blocked' ? { id: 'raised', unread: true } : null,
      );
      hub = {
        raise,
        list: () => [],
        markRead: () => undefined,
        clear: () => undefined,
        promote: vi.fn(() => true),
        dismissForeground,
        dismissForSession,
      } as unknown as NotificationHub;
      const n = createNotifier({ hub, isForeground: () => false });

      n.observe(CH.sessionStatus, block('sess-05'));
      // Still `waiting` — the elicitation's block was never paired away.
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'waiting',
        event: 'Notification',
        notificationType: 'idle_prompt',
      });
      // The user types, which is what clears `blocked` wholesale.
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'UserPromptSubmit',
      });

      expect(dismissForSession).toHaveBeenCalledWith('sess-05', ['session.blocked']);
    });

    /**
     * `supersedeKey` keeps at most one `session.blocked` row per session, which
     * is what makes a boolean mark sound rather than a count.
     */
    it('sweeps once after a second block replaced the first', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, block('sess-05'));
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'PostToolUse',
      });

      expect(dismissForSession).toHaveBeenCalledTimes(1);
      expect(dismissForSession).toHaveBeenCalledWith('sess-05', ['session.blocked']);
    });

    /** Nothing blocked, nothing to sweep — the buffer is never scanned. */
    it('never asks about a session that has not blocked', () => {
      const n = withSweeps();

      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'working',
        event: 'UserPromptSubmit',
      });
      n.observe(CH.sessionStatus, {
        entityId: 'sess-05',
        status: 'idle',
        event: 'Stop',
      });

      expect(dismissForSession).not.toHaveBeenCalled();
    });
  });
});
