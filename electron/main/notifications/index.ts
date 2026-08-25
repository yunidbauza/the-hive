import type { StatusHookEvent } from '../../shared/hook-contract';
import { CH } from '../../shared/ipc-contract';
import type { NotificationKind } from '../../shared/notification-contract';

import type { NotificationHub } from './hub';

/**
 * Turning main's broadcast into notifications (story 106, rewritten by HIVE-75).
 *
 * ## Why a tap on the broadcast, not a call at each source
 *
 * Every event main pushes to the renderer already funnels through one `send` in
 * `ipc/index.ts`. Tapping that once means an event class added later cannot
 * forget to notify, whereas a call site per source would be a rule enforced by
 * memory. It also keeps this module out of the sessions and clone layers
 * entirely — they push what they already pushed, and know nothing about
 * notifications.
 *
 * ## What changed in HIVE-75
 *
 * This module used to *present* — it built an Electron notification and showed
 * it — while the inbox in the renderer was a fixture that knew nothing about any
 * of it. Two notification systems that could not disagree only because they
 * never spoke.
 *
 * Now it decides **what happened** and hands that to the hub, which decides what
 * to do about it. The split earns its extra file: this one is a translation
 * table from channels to kinds, and it is the only thing that has to change when
 * a new channel becomes worth announcing.
 *
 * ## What changed when the `Notification` hook was added
 *
 * The translation table gained the event it was missing. Two of the three ways
 * a session blocks on a human were already here — a tool wanting approval, an
 * MCP server wanting a sentence — and the commonest one was not: the turn ended
 * and nobody typed. Nothing reported it, so the app said nothing, which is the
 * bug the story was opened for.
 *
 * `Stop` was never the answer. It fires at the end of every turn, including the
 * many the user is watching, and a row per turn is the notification stream
 * people stop reading. Claude's `Notification/idle_prompt` fires sixty seconds
 * later with nobody having typed, and that debounce is the whole difference.
 *
 * ## The foreground gate (HIVE-81)
 *
 * "Main cannot know which session the user is looking at; `activeTab` is
 * renderer state" was correct when this was written, and it was an argument
 * against a rule main could only get wrong: the sole fact it could observe
 * on its own was window focus, and applying that alone would go quiet
 * whenever any window was focused — suppressing precisely the case this
 * feature exists for, a background session finishing while the user works in
 * another terminal.
 *
 * What changed is that `activeTab` stopped being renderer-only. The renderer
 * now reports the terminal id on the centre stage over `CH.uiForeground`
 * every time it changes; main holds that alongside `BrowserWindow` focus
 * (`isForeground` in `ipc/index.ts`), and a session only reads as "the one
 * being watched" when both agree — the id matches *and* the window has OS
 * focus. That composed predicate is threaded into this module as
 * `NotifierOptions.isForeground` and into the hub as its own
 * `NotificationHub` option of the same name, so a background session behind
 * a focused window, or the right tab behind an unfocused one, still
 * interrupts.
 *
 * The gate this predicate drives lives in the hub, not here (see
 * `raise`'s "downgrade, never drop" in `hub.ts`): a notification for the
 * foreground session is kept — not suppressed — and raised already-read, so
 * the inbox row exists for anyone who scrolls back but the toast, the dock
 * bounce and the unread badge stay quiet. `reevaluateForeground` below is
 * the other half — the re-arm when the user looks away while still blocked.
 */

export interface NotifierOptions {
  hub: NotificationHub;
  /**
   * Is this session's terminal the one the user is looking at right now
   * (HIVE-81)?
   *
   * Takes an entity id rather than a `NotificationAction`, unlike the hub's own
   * `isForeground` — this module never sees an action, only the payloads on the
   * broadcast it taps. The adapter that reconciles the two lives at the
   * `createNotificationHub` call site in `ipc/index.ts`.
   */
  isForeground: (entityId: string) => boolean;
}

export interface Notifier {
  /** Called for every main → renderer broadcast. Most are not event classes. */
  observe(channel: string, payload: unknown): void;
  /**
   * Foreground state changed — window focus, or a different tab (HIVE-81).
   *
   * Anything still blocked that the user can no longer see gets its row
   * promoted. Called by main on focus, blur and every foreground report;
   * cheap, because the map is empty except while a session is blocked on a
   * tab the user is actually looking at.
   */
  reevaluateForeground(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The two ways Claude blocks on a human, now one kind (HIVE-83).
 *
 * `hook-contract.ts` maps `PermissionRequest` and `Elicitation` to the same
 * *status* — they are "different mechanisms and the same fact about the
 * session". They used to be kept apart as notifications too, on the theory
 * that "approve this command" and "answer this question" ask different things.
 * That split did not survive measurement: `Elicitation` (MCP elicitation)
 * effectively never fires, while the real question case — the
 * `AskUserQuestion` tool — arrives as `PermissionRequest` and wore "needs
 * approval" copy regardless. One kind now; {@link waitingCopy} is where the
 * cause still shows up, in the words rather than in a second switch.
 */
const WAITING_KIND: Record<string, NotificationKind> = {
  PermissionRequest: 'session.blocked',
  Elicitation: 'session.blocked',
};

/**
 * The third way, and the one that arrives on the `Notification` hook.
 *
 * Keyed on `notification_type` rather than folded into {@link WAITING_KIND},
 * because `Notification` is a single event that means two different things and
 * only one of them belongs in the inbox:
 *
 * - `idle_prompt` — the turn ended and sixty seconds passed with nothing typed.
 *   Nothing else reports this, and it is the commonest way a session ends up
 *   waiting on a human.
 * - `permission_prompt` — mapped to `undefined` **on purpose**. It arrives about
 *   six seconds behind the `PermissionRequest` that already raised
 *   `session.blocked`, so raising anything here would be the same interruption
 *   twice, six seconds apart. The status still moves to `waiting` — that path
 *   runs before this one — which is the whole of what this event adds once the
 *   first has been seen.
 */
const NOTIFICATION_TYPE_KIND: Record<string, NotificationKind | undefined> = {
  idle_prompt: 'session.input_needed',
  permission_prompt: undefined,
};

/**
 * What each block says. Keyed on what blocked, not on the kind — one kind now
 * covers all three, and the row is where the difference survives.
 */
function waitingCopy(
  event: StatusHookEvent,
  toolName?: string,
): { title: string; body: string } {
  if (event === 'Elicitation')
    return {
      title: 'needs an answer',
      body: 'An MCP server is waiting on you.',
    };
  if (toolName === 'AskUserQuestion')
    return {
      title: 'asked a question',
      body: 'It cannot carry on until you answer.',
    };
  return { title: 'needs approval', body: 'A tool is waiting on you.' };
}

/**
 * What the two kinds that are not blocks say. Neither goes through
 * {@link waitingCopy}: `session.input_needed` is the nudge a minute after the
 * turn, `session.idle` (HIVE-89) is the moment work stopped — a different
 * sentence. Keyed by kind so the raise below looks the copy up rather than
 * branching on it.
 */
const PLAIN_COPY: Partial<
  Record<NotificationKind, { title: string; body: string }>
> = {
  'session.input_needed': {
    title: 'is waiting on you',
    body: 'It finished its turn and has nothing left to do.',
  },
  'session.idle': {
    title: 'is yours again',
    body: 'Its turn ended and nothing is left running in the background.',
  },
};

/**
 * Whether something is still running behind an `idle`.
 *
 * Presence, not membership: `session-contract.ts` promises `idleDetail` is
 * only ever set alongside `idle` and only when something *is* running, so a
 * new member of `IdleDetail` is live by construction and this stays true
 * without being told. Re-listing the union here would have answered "nothing
 * running" for a detail this file had never heard of.
 */
const hasLiveDetail = (idleDetail: unknown): boolean => idleDetail !== undefined;

/**
 * Which inbox kind a `waiting` status is, or `undefined` for none.
 *
 * A free function so the two-step lookup reads as one question. `undefined` is
 * a real answer twice over and the two are deliberately indistinguishable here:
 * a hook this build has no reading of, and `permission_prompt`, which is a
 * second sighting of something already announced. Both mean "move the dot, say
 * nothing", and the caller needs no more than that.
 */
function waitingKind(
  event: unknown,
  notificationType: unknown,
): NotificationKind | undefined {
  /**
   * `Object.hasOwn`, not a bare index.
   *
   * Both arguments arrive as `unknown` off an IPC payload, and a plain lookup
   * on an object literal walks the prototype — so `'constructor'` or
   * `'toString'` answers with an inherited *function*, which sails past a
   * `=== undefined` guard and then throws two lines later when the copy table
   * has no entry for it. `observe`'s try would catch it, so the cost is one
   * dropped notification rather than a crash, which is precisely why it would
   * never be noticed.
   *
   * The receiver already validates against the closed vocabulary before any of
   * this runs, so nothing reachable today gets here. That is an argument for
   * leaving the guard in, not out: the validation is one refactor away from
   * moving, and this function's signature promises to cope with anything.
   */
  if (event === 'Notification') {
    if (typeof notificationType !== 'string') return undefined;
    return Object.hasOwn(NOTIFICATION_TYPE_KIND, notificationType)
      ? NOTIFICATION_TYPE_KIND[notificationType]
      : undefined;
  }
  if (typeof event !== 'string') return undefined;
  return Object.hasOwn(WAITING_KIND, event) ? WAITING_KIND[event] : undefined;
}

/**
 * The session is over, however it got there (HIVE-93).
 *
 * `terminated` was the only ending this module knew, because it was the only
 * one main could publish. `/done` added a second, and every check that meant
 * "this session is finished" has to cover both or it silently covers neither
 * for half of them: a `/done` row would keep a pending "is waiting on you" row
 * alive, promotable into a toast whose click opens a session that is gone.
 *
 * A predicate rather than three widened conditions, so the next ending is added
 * in one place instead of found in three.
 */
const hasEnded = (status: string): boolean =>
  status === 'terminated' || status === 'done';

function stillRelevant(
  kind: NotificationKind,
  status: string,
  event: unknown,
): boolean {
  if (kind === 'session.input_needed') {
    return !(event === 'UserPromptSubmit' || hasEnded(status));
  }
  /**
   * `session.idle` is `both`, so a promotion is a toast, and a toast that
   * says "is yours again" about a session that has since gone back to work
   * is a lie (HIVE-89). So this one expires the moment the session is no
   * longer idle — which covers engagement (`UserPromptSubmit` reports
   * `working`), `terminated`, and a turn that resumed without a typed prompt
   * alike — rather than borrowing `input_needed`'s engagement-only rule.
   */
  if (kind === 'session.idle') return status === 'idle';
  /**
   * The status is trustworthy again (HIVE-83).
   *
   * This used to read `status === 'waiting' || event === 'PostToolUse'`,
   * because a sibling tool's completion in a parallel batch would flip the
   * session to `working` while a permission was still outstanding. The tracker
   * pairs tool events by `tool_use_id`, so `waiting` now means blocked and the
   * notifier can stop compensating for a status it did not trust.
   */
  return status === 'waiting';
}

export function createNotifier(options: NotifierOptions): Notifier {
  const { hub, isForeground } = options;

  /*
   * A note on `/clear`, which `observe` does not handle and does not need to.
   *
   * Both per-session maps below (`announcedInputNeeded`, `pendingForeground`)
   * are keyed by **terminal** id and survive a `/clear`, because `observe`
   * reads `sessionStatus`, `sessionName` and `configCloneDone` and never
   * `CH.sessionCleared`. That is deliberate rather than overlooked, and it is
   * stated here because everything else in this file is.
   *
   * `/clear` ends the conversation, not the terminal — `publishCleared`
   * (`sessions/index.ts`) tears nothing down and the entity id is unchanged —
   * so the entries are not stale in the sense of naming something gone. And
   * both clear on the same act that always follows a `/clear`: the user types,
   * which is `UserPromptSubmit`, which is the engagement rule both maps
   * already use. The blocked kind is covered a second way over — a `/clear`
   * cannot be typed past an outstanding permission prompt, so a pending
   * `session.blocked` is answered before a `/clear` is even reachable.
   */

  /**
   * Sessions already announced as out of instructions.
   *
   * `Notification/idle_prompt` is the only producer here that Claude may repeat
   * on its own: it fires sixty seconds after a turn ends with nothing typed, and
   * a session left alone all afternoon is a session that can reach that
   * condition again without anything having changed. The hub's own dedup cannot
   * help — it keys on an id, and every repeat is a genuinely new event at a new
   * time.
   *
   * So the suppression is stated in terms of the *session* rather than the
   * event: announced once, and cleared only by **engagement**, never by
   * idleness itself. See the `event === 'UserPromptSubmit' || status ===
   * 'terminated'` check below for what engagement means and why.
   *
   * ## A dismissal does not clear it, and that is the decision
   *
   * Dismissing a gated `session.input_needed` row leaves the session's mark in
   * place, so it stays quiet until the user actually types. Reviewed and kept
   * (HIVE-81, finding 9): **a dismissal is acknowledgement.** The user was told
   * the session is waiting on them and swiped it away; re-announcing the same
   * unchanged fact sixty seconds later is the behaviour this branch exists to
   * end — the running app said "is waiting on you" four times in twenty-six
   * minutes about one idle session. Clearing the mark on dismiss would hand
   * that back, with the dismissal itself as the trigger. Recorded here so the
   * next reader does not read it as an oversight and repair it.
   */
  const announcedInputNeeded = new Set<string>();

  /**
   * Sessions whose next true idle is worth announcing (HIVE-89).
   *
   * `session.idle` is an edge — raised on the transition into "idle and
   * nothing running" — and this set is what makes it one. A session is armed
   * by `UserPromptSubmit`, the one event that says a turn is the user's, and
   * the first `Stop` that lands `idle` with no `idleDetail` spends the arm.
   * `terminated` drops it.
   *
   * Stated as "armed" rather than as "already announced" (the shape
   * `announcedInputNeeded` takes) on purpose: it means a session that has not
   * typed yet — a `SessionStart` idle, a resumed conversation — never
   * announces, because nothing ever armed it. The inverse shape would have
   * announced every spawn the moment it reported idle, which is the defect
   * that retired the old `session.idle`.
   *
   * ## Why only `Stop` spends it — measured, not the brief
   *
   * HIVE-89 named three events that reach the moment: `Stop` with nothing
   * outstanding, the `SubagentStop` that retires the last agent, and the last
   * background shell finishing. The live run (`tests/live/hook-conformance`)
   * showed the last two are not moments of their own. Claude Code reports a
   * finished background shell only as a re-invoke — an internal
   * `UserPromptSubmit` that clears `bgShells` — followed by a `Stop`; and a
   * subagent's result is collected the same way: `SubagentStop` (idle, no
   * detail) -> internal `UserPromptSubmit` -> `Stop`. At `SubagentStop` the
   * main agent is about to run again, so the session is not yet the user's,
   * and announcing there *and* on the `Stop` that follows was two rows for one
   * fact — precisely what the ticket ruled out. So `SubagentStop` does not
   * spend the arm; the `Stop` after the re-invoke does, and both of the
   * ticket's "later" cases arrive as that `Stop`. That re-invoke is
   * indistinguishable from a typed prompt (see `tracker.ts`), which is fine
   * here: it re-arms a session that has just been disarmed by nothing, and
   * the one `Stop` that follows is the one row.
   *
   * ## What this knowingly gets wrong, and why it is left that way
   *
   * - A `Stop` hook elsewhere in the user's settings that answers `block`
   *   makes Claude carry on; the `Stop` this app saw has already spent the
   *   arm, and the real one later is silent. Re-arming on the `working` that
   *   follows would announce both — and "idle → working → idle inside one
   *   turn must not announce twice" is the rule the ticket set. One early row
   *   is the cheaper mistake.
   * - A background shell whose `Stop` body was over `HOOK_MAX_BODY_BYTES`
   *   leaves the tracker on its inference, which cannot see a shell that
   *   finished inside its turn — so `script` stands until the next prompt and
   *   silences both this kind and `input_needed` for that stretch. This was
   *   the ordinary case until HIVE-90; `Stop` and `SubagentStop` carry a live
   *   `background_tasks` list, the tracker replaces `bgShells` from it, and
   *   what is left is only the truncated body — `last_assistant_message`
   *   precedes the list on the wire, so a final message over 64 KB takes it
   *   with it. Still the tracker's to fix rather than this file's, and the
   *   contract is unchanged: the detail is trusted in the idle window, and
   *   this file trusts it.
   * - `/clear` and an Escape-interrupted turn leave the arm where it was. Harmless:
   *   nothing reaches a `Stop` again without a `UserPromptSubmit`, which
   *   re-arms anyway. See the `/clear` note above `announcedInputNeeded`.
   */
  const armedIdle = new Set<string>();

  /**
   * What each session calls itself, as the rail shows it (HIVE-81).
   *
   * A notification that says `sess-01` names something the user has never seen.
   * The rail, the tab and the meta bar all read `INCORP-478`, because the
   * session renamed itself from its own terminal title — and an interruption
   * that cannot be matched to the thing it interrupted about is most of the way
   * to useless.
   *
   * Populated from `CH.sessionName`, which already passes through this
   * observer on its way to the renderer; this simply stops ignoring it. The
   * entity id remains the fallback, because a session that has not renamed
   * itself yet genuinely has no better name.
   *
   * Never pruned. An entry is two short strings, and the map is bounded by the
   * number of sessions this process has ever spawned — cheap enough that
   * pruning it would buy nothing.
   */
  const names = new Map<string, string>();

  /** What to call this session in a title or a body. */
  const nameFor = (entityId: string): string => names.get(entityId) ?? entityId;

  const nameEvent = (payload: Record<string, unknown>): void => {
    const { entityId, name } = payload;
    if (typeof entityId !== 'string' || typeof name !== 'string') return;
    names.set(entityId, name);
  };

  /**
   * Rows raised silently because the user was watching, and the session they
   * are about (HIVE-81).
   *
   * Keyed by session so a second block replaces the first: only the current
   * question is worth promoting, and the previous one is either answered or
   * superseded.
   *
   * The **kind** is kept alongside the id because the promotion has a
   * condition — the row must still be worth chasing the user about — and the
   * foreground change that triggers it carries nothing of its own to test.
   * See {@link stillRelevant} for why the kind is the right thing to keep.
   */
  const pendingForeground = new Map<
    string,
    { id: string; kind: NotificationKind }
  >();

  /**
   * A session declared itself finished (HIVE-93).
   *
   * Routed into {@link sessionEvent} as an ending rather than handled here,
   * because everything this needs to do is already what an ending does: expire
   * a pending row, drop the "already told them" mark, disarm the idle watch.
   *
   * It needs its own branch at all because a declared finish does **not** reach
   * the status channel. It leaves on `session:finished`, and the `terminated`
   * that `activity.ts` observes a moment later is deliberately suppressed —
   * so without this the notifier never learns the session ended. The visible
   * cost was a promoted toast saying a finished session was waiting on the
   * user, whose click opened a session that no longer existed, plus a leaked
   * entry per finish under an id a resume can reuse.
   */
  const finishedEvent = (payload: Record<string, unknown>): void => {
    const { entityId } = payload;
    if (typeof entityId !== 'string') return;
    sessionEvent({ entityId, status: 'done' });
  };

  const sessionEvent = (payload: Record<string, unknown>): void => {
    const { entityId, status, event, notificationType, toolName, idleDetail } =
      payload;
    if (typeof entityId !== 'string' || typeof status !== 'string') return;

    const action = { type: 'session', entityId } as const;

    /**
     * Cleared when the **user** comes back, and by nothing else.
     *
     * This has now been wrong twice in opposite directions. It first cleared on
     * any non-`waiting` status, so every turn boundary re-armed it. Task 1
     * narrowed that to `working`, which held until `PostToolUse` was
     * subscribed — a backgrounded agent runs tools, every tool reports
     * `working`, and the mark was cleared again on work the user had no part
     * in. Observed in the running app: the same "is waiting on you" row four
     * times in twenty-six minutes, while a background agent worked and nothing
     * was waiting on anybody.
     *
     * The rule the set has always been reaching for is "announced once, until
     * the user comes back". A tool finishing is not that. A turn ending is not
     * that. `UserPromptSubmit` is exactly that — it is the user typing — and
     * `terminated` ends the question by ending the session.
     *
     * Main *can* now tell why a session is idle (HIVE-83 / HIVE-84), and
     * `idleDetail` is how: the tracker pairs tool events by id, knows which
     * subagents and background shells are still live, and ships the answer in
     * the same payload that triggers this notification. HIVE-89 spends that —
     * the raise below is gated on the detail, so an `idle_prompt` under a
     * running agent or script no longer raises at all. What it does **not**
     * change is the clearing rule, and the repetition argument is why: the
     * same "is waiting on you" row four times in twenty-six minutes was not a
     * misreading of *why* the session was idle, it was the mark being cleared
     * by things that were not the user. Engagement is still the only thing
     * that clears it.
     */
    if (event === 'UserPromptSubmit' || hasEnded(status)) {
      announcedInputNeeded.delete(entityId);
    }

    /**
     * The arm for `session.idle` (HIVE-89): held from the user's prompt to
     * the first idle with nothing running, and dropped by `terminated`. See
     * `armedIdle`.
     */
    if (event === 'UserPromptSubmit') armedIdle.add(entityId);
    else if (hasEnded(status)) armedIdle.delete(entityId);

    /**
     * The pending row expires by its own kind's rule (HIVE-81).
     *
     * For `session.blocked` that is a different rule from
     * `announcedInputNeeded`'s just above — it ends when the session stops
     * being blocked, full stop, now that the tracker (not this file) is what
     * keeps `waiting` honest across a sibling tool's `PostToolUse`. For
     * `session.input_needed` it is deliberately the *same* rule, applied to the
     * same event, because the mark and the pending row are two halves of one
     * announcement. See {@link stillRelevant}.
     */
    const pending = pendingForeground.get(entityId);
    if (pending !== undefined && !stillRelevant(pending.kind, status, event)) {
      pendingForeground.delete(entityId);
    }

    /**
     * The inbox is routed off the hook **event**, never off the status.
     *
     * These are two different questions that used to share one branch. The
     * status answers "is this session blocked" — it drives the dot and the
     * fleet counts. The notification answers "did something happen worth
     * telling you about". `idle_prompt` is the case that proves they are not
     * the same: nothing is blocked, and the user still needs to know.
     *
     * `waitingKind` already keys purely off the event, so every hook that is
     * not an inbox event — `Stop`, `UserPromptSubmit`, `SessionStart`,
     * `permission_prompt` behind a `PermissionRequest` — answers `undefined`
     * and we stop here. That is the same set that was silent before.
     */
    if (event !== undefined) {
      /**
       * The edge `session.idle` is raised on (HIVE-89): a `Stop` that lands
       * `idle` with nothing still running, while the arm is held. See
       * `armedIdle` for why it is an arm and why only `Stop` spends it.
       */
      const trueIdle =
        event === 'Stop' &&
        status === 'idle' &&
        !hasLiveDetail(idleDetail) &&
        armedIdle.has(entityId);
      const kind =
        waitingKind(event, notificationType) ??
        (trueIdle ? ('session.idle' as const) : undefined);
      if (kind === undefined) return;

      /*
        `session.input_needed` keeps its meaning — a minute passed and nothing
        was typed — and stops firing while something is still running
        (HIVE-89). The mark is deliberately not spent by a suppressed prompt:
        the one that arrives after the agent finishes is the first real one.
      */
      if (kind === 'session.input_needed' && hasLiveDetail(idleDetail)) return;

      /*
        Marked before the raise, and deliberately not rolled back when the raise
        is gated. The gate downgrades, it does not drop: the row exists, and the
        promotion below is what delivers it. A repeat while the user is still
        watching must therefore raise nothing — a second row for a fact already
        sitting in the inbox — and the one pending entry carries the
        announcement the rest of the way.
      */
      if (kind === 'session.input_needed') {
        if (announcedInputNeeded.has(entityId)) return;
        announcedInputNeeded.add(entityId);
      }

      if (kind === 'session.idle') armedIdle.delete(entityId);

      const copy =
        PLAIN_COPY[kind] ??
        waitingCopy(
          event as StatusHookEvent,
          typeof toolName === 'string' ? toolName : undefined,
        );
      const raised = hub.raise({
        kind,
        title: `${nameFor(entityId)} ${copy.title}`,
        body: copy.body,
        action,
      });

      /*
        Remember it if, and only if, it was gated — `unread: false` off a raise
        that happened is the hub saying "kept, but delivered to nobody". No
        status test: every kind that reaches here is one of the three the user
        is owed (`session.blocked`, `session.input_needed`, `session.idle`),
        and how long each stays owed is `stillRelevant`'s job, above. Nothing
        pty-derived can reach here at all — this branch only runs when
        `event !== undefined`.
      */
      if (raised !== null && !raised.unread) {
        /*
          One exception to "the newer replaces the older" (HIVE-89). A gated
          `session.idle` is followed, a minute later and still gated, by the
          `session.input_needed` for the same stretch — the same fact, said
          twice, and the older is the one that toasts (`both`) while the newer
          is inbox-only. Letting the nudge evict the moment would promote the
          weaker of two rows about one idle and leave the stronger unread for
          good. Both expire by `stillRelevant` on the same `UserPromptSubmit`,
          so keeping the first costs nothing in staleness.
        */
        const pending = pendingForeground.get(entityId);
        if (kind === 'session.input_needed' && pending?.kind === 'session.idle')
          return;
        pendingForeground.set(entityId, { id: raised.id, kind });
      }
      return;
    }

    /**
     * Only pty-derived statuses reach here, and since HIVE-83 none of them
     * raise. The old `session.idle` was reachable only on this path and was
     * blocked by the `hookDriven` gate for every session that ever sent a
     * hook, so it never fired for a Claude session — the kind HIVE-89 revived
     * under that name is hook-driven and handled above; `session.ended` was
     * retired because `/exit` is deliberate and the fleet view already shows
     * the row.
     */
  };

  const cloneEvent = (payload: Record<string, unknown>): void => {
    const { ok, reason } = payload;
    if (typeof ok !== 'boolean') return;

    hub.raise({
      kind: 'clone.done',
      title: ok ? 'Clone finished' : 'Clone failed',
      body:
        ok || typeof reason !== 'string' ? 'The repository is ready.' : reason,
      /**
       * A clone has no session to open.
       *
       * Clicking still dismisses the notification, which is what the OS does
       * for free; inventing a destination — the settings pane, say — would take
       * the user somewhere they did not ask to go.
       */
      action: { type: 'none' },
    });
  };

  return {
    observe(channel, payload) {
      if (!isRecord(payload)) return;

      /**
       * Nothing here may throw — the hub says the same of itself, and this runs
       * one layer closer to `send`. Belt and braces on the path that carries
       * every session's output.
       */
      try {
        if (channel === CH.sessionStatus) sessionEvent(payload);
        else if (channel === CH.sessionFinished) finishedEvent(payload);
        else if (channel === CH.sessionName) nameEvent(payload);
        else if (channel === CH.configCloneDone) cloneEvent(payload);
      } catch (cause) {
        console.error('[hive] notification failed:', cause);
      }
    },

    reevaluateForeground(): void {
      // Delete only on success. `hub.promote` answers `false` when a
      // collaborator (typically `prefs`) threw partway through — the entry
      // stays pending so the next focus change tries again, rather than the
      // session going silently un-rearmed for good.
      for (const [entityId, pending] of pendingForeground) {
        if (isForeground(entityId)) continue;
        if (hub.promote(pending.id)) pendingForeground.delete(entityId);
      }
    },
  };
}

export { createNotificationHub } from './hub';
export type {
  NotificationHub,
  NotificationInput,
  NotificationPresenter,
} from './hub';
