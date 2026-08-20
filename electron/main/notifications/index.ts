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
 * ## No focus suppression
 *
 * The obvious rule — stay quiet while the app is focused — is not implementable
 * *correctly* from here. Main cannot know which session the user is looking at;
 * `activeTab` is renderer state. The only version main could apply on its own is
 * "quiet whenever any window is focused", which would suppress precisely the
 * case this feature exists for: a background session finishing while the user
 * works in another terminal. The per-kind delivery is the control, and there is
 * no second, invisible one.
 */

export interface NotifierOptions {
  hub: NotificationHub;
}

export interface Notifier {
  /** Called for every main → renderer broadcast. Most are not event classes. */
  observe(channel: string, payload: unknown): void;
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

export function createNotifier(options: NotifierOptions): Notifier {
  const { hub } = options;

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
   * event: announced once, and cleared only by **engagement** — the user typed
   * (`working`) or the session ended (`terminated`) — never by idleness itself.
   * A plain hook-driven idle in between must not re-arm it; only the user coming
   * back does.
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

      if (kind === 'session.input_needed') {
        if (announcedInputNeeded.has(entityId)) return;
        announcedInputNeeded.add(entityId);
      }

      const copy = WAITING_COPY[kind];
      hub.raise({
        kind,
        title: `${nameFor(entityId)} ${copy.title}`,
        body: copy.body,
        action,
      });
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
  };
}

export { createNotificationHub } from './hub';
export type {
  NotificationHub,
  NotificationInput,
  NotificationPresenter,
} from './hub';
