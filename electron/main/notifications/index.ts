import { CH } from '../../shared/ipc-contract';
import type { NotificationKind } from '../../shared/notification-contract';
import type { DerivedStatus } from '../../shared/session-contract';

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
 * The session statuses that are event classes. `working` is not one.
 *
 * `waiting` is absent on purpose: it is reached only through a hook, and *which*
 * hook decides which of two kinds it becomes. See {@link WAITING_KIND}.
 *
 * The **preference key changed** where the old one was misnamed — `sessionDone`
 * answered a status called `terminated` — and nobody's saved choice is lost by
 * it, because `resolveNotificationPrefs` migrates the legacy booleans. That is
 * what made the rename affordable this time round.
 */
const SESSION_KIND: Partial<Record<DerivedStatus, NotificationKind>> = {
  terminated: 'session.ended',
  idle: 'session.idle',
};

/**
 * The two ways Claude blocks on a human, kept apart.
 *
 * `hook-contract.ts` maps `PermissionRequest` and `Elicitation` to the same
 * *status*, correctly — they are "different mechanisms and the same fact about
 * the session". They are not the same fact about the **user**: one wants a yes,
 * the other wants a sentence, and the concept mock shows them as two rows with
 * two glyphs. A status may collapse them; a notification may not, which is why
 * `SessionStatusEvent` now carries the hook event alongside the status.
 */
const WAITING_KIND: Record<string, NotificationKind> = {
  PermissionRequest: 'session.waiting',
  Elicitation: 'session.asked',
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
 *   `session.waiting`, so raising anything here would be the same interruption
 *   twice, six seconds apart, with two different glyphs. The status still moves
 *   to `waiting` — that path runs before this one — which is the whole of what
 *   this event adds once the first has been seen.
 */
const NOTIFICATION_TYPE_KIND: Record<string, NotificationKind | undefined> = {
  idle_prompt: 'session.input_needed',
  permission_prompt: undefined,
};

/** What each blocked kind says, keyed so the copy sits beside the mapping. */
const WAITING_COPY: Record<string, { title: string; body: string }> = {
  'session.waiting': {
    title: 'needs approval',
    body: 'A tool is waiting on you.',
  },
  'session.asked': {
    title: 'asked a question',
    body: 'It cannot carry on until you answer.',
  },
  'session.input_needed': {
    title: 'is waiting on you',
    body: 'It finished its turn and has nothing left to do.',
  },
};

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
 * Is a row raised silently still worth chasing the user about (HIVE-81)?
 *
 * **Relevance is a property of the kind, not of the status**, and getting that
 * backwards is what a review of this branch caught. A single
 * `status === 'waiting'` test was applied to every gated row, which was right
 * for the two kinds that come *from* a blocked status and silently wrong for
 * the one that does not: after Part 3.1, `idle_prompt` reports `idle`, so a
 * gated `session.input_needed` was never recorded as pending at all — while
 * `announcedInputNeeded` had already been spent on it. The row existed,
 * already-read, with no toast, no badge and no path back to unread; on a
 * machine where the OS refuses toasts that is the notification never being
 * delivered by any route.
 *
 * So each kind is cleared by its own rule, and the two are exactly the rules
 * already written down elsewhere in this file rather than a third idea:
 *
 * - `session.input_needed` asks nothing of the session — it says the user has
 *   gone quiet — so only the **user** can end it. That is
 *   `announcedInputNeeded`'s rule verbatim, which is the point: the mark and
 *   the pending row are two halves of one announcement, and they must expire
 *   together or the announcement is lost between them.
 * - `session.waiting` and `session.asked` are questions the *session* is
 *   blocked on, so they end when it stops being blocked — with one exception,
 *   below, that a plain `status === 'waiting'` test gets wrong.
 *
 * ## Why `PostToolUse` does not end a block
 *
 * **A tool finishing tells you nothing about whether a *different* tool is
 * still waiting on you.** Claude routinely runs tools in parallel: tool B asks
 * for permission, the session goes `waiting`, the row is raised gated and
 * recorded pending — and then tool A, a sibling in the same batch, completes.
 * `PostToolUse` reports `working`, the old rule dropped the entry, and tool B's
 * permission was still outstanding. Nothing re-records it either:
 * `Notification/permission_prompt` maps to `undefined` in
 * {@link NOTIFICATION_TYPE_KIND} by design, so it never raises and never
 * records. The user looks away and finds a session that is blocked and silent.
 *
 * So a blocked kind survives a non-`waiting` status when the event that
 * carried it was `PostToolUse`. `UserPromptSubmit` (the user is demonstrably
 * back), `Stop` (the turn ended, so nothing in it can still be blocked),
 * `terminated`, and any pty-derived status change all still end it.
 *
 * ### The trade-off, stated rather than hidden
 *
 * This buys the elimination of a false negative with a possible false
 * positive, knowingly. **What it costs:** if the user answers the permission
 * and the turn then runs for several minutes, the entry survives until `Stop`;
 * a blur in that window promotes a row about a block already answered. The
 * user looks, finds the session working, moves on. **Why that is the right
 * direction:** the alternative is silence about a genuinely blocked session,
 * which is the one failure the whole attention model exists to prevent — the
 * spec says so in as many words ("Suppression must not lose a real
 * notification"). A stale interruption is recoverable in a glance; a lost one
 * is not recoverable at all.
 *
 * **Why we cannot do better here.** `StatusHookPayload` carries no tool
 * identity, so main cannot tell the blocked tool's `PostToolUse` from a
 * sibling's. Counting `PermissionRequest`s against `PostToolUse`s does not
 * work either: `PostToolUse` fires for *every* tool, not only the
 * permission-gated ones, so the count drains on tools that were never blocked.
 *
 * ### A related consequence, deliberately not fixed here
 *
 * That same sibling `PostToolUse` also moves the session's **status dot** off
 * "needs input" while a permission is genuinely outstanding. That is a display
 * bug in the status pipeline (`hook-contract.ts`'s `HOOK_STATUS`, Part 3.4),
 * not in the notifier, and it is out of scope on this branch.
 */
function stillRelevant(
  kind: NotificationKind,
  status: string,
  event: unknown,
): boolean {
  if (kind === 'session.input_needed') {
    return !(event === 'UserPromptSubmit' || status === 'terminated');
  }
  return status === 'waiting' || event === 'PostToolUse';
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
   * already use. The blocked kinds are covered a second way over — a `/clear`
   * cannot be typed past an outstanding permission prompt, so a pending
   * `session.waiting` is answered before a `/clear` is even reachable.
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
   * Never pruned. An entry is two short strings, the map is bounded by the
   * number of sessions this process has ever spawned, and a session that has
   * exited can still be the subject of a `session.ended` notification.
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

  const sessionEvent = (payload: Record<string, unknown>): void => {
    const { entityId, status, event, notificationType } = payload;
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
     * What this deliberately does not do is guess *why* a session is idle. Main
     * cannot tell "idle because a background agent is running" from "idle
     * because you walked away"; Claude fires `idle_prompt` for both. So this
     * does not try to suppress the first — it makes the app say it once instead
     * of four times, which is the part that was actually wrong.
     */
    if (event === 'UserPromptSubmit' || status === 'terminated') {
      announcedInputNeeded.delete(entityId);
    }

    /**
     * The pending row expires by its own kind's rule (HIVE-81).
     *
     * For `session.waiting` and `session.asked` that is a different rule from
     * `announcedInputNeeded`'s just above — they end when the session stops
     * being blocked, except by a `PostToolUse`, which may be a sibling tool in
     * the same batch and says nothing about the one still asking. For
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
      const kind = waitingKind(event, notificationType);
      if (kind === undefined) return;

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

      const copy = WAITING_COPY[kind];
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
        is owed (`session.waiting`, `session.asked`, `session.input_needed`),
        and how long each stays owed is `stillRelevant`'s job, above.
        `session.idle` and `session.ended` cannot reach here at all — they are
        records rather than questions, and they are raised on the pty-derived
        path below, which records nothing.
      */
      if (raised !== null && !raised.unread) {
        pendingForeground.set(entityId, { id: raised.id, kind });
      }
      return;
    }

    /**
     * Only pty-derived statuses reach here — they carry no hook event.
     *
     * This is the same guarantee the old `status === 'idle' && event !== undefined`
     * line bought, stated once for every status instead of specially for one.
     * The event it keeps is the pty going silent for `ACTIVITY_IDLE_MS`, which
     * is what `session.idle` has always been about (HIVE-75).
     */
    const kind = SESSION_KIND[status as DerivedStatus];
    if (kind === undefined) return;

    const terminated = kind === 'session.ended';
    hub.raise({
      kind,
      title: terminated ? 'Session ended' : 'Session idle',
      body: terminated
        ? `${nameFor(entityId)} has exited.`
        : `${nameFor(entityId)} has gone quiet.`,
      action,
    });
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
