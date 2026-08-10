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
};

export function createNotifier(options: NotifierOptions): Notifier {
  const { hub } = options;

  const sessionEvent = (payload: Record<string, unknown>): void => {
    const { entityId, status, event } = payload;
    if (typeof entityId !== 'string' || typeof status !== 'string') return;

    const action = { type: 'session', entityId } as const;

    if (status === 'waiting') {
      /**
       * A `waiting` with no hook event is dropped rather than guessed at.
       *
       * The status is only reachable from a hook, so an event without one is a
       * shape this build does not understand — and picking either kind would
       * show the user a glyph and a sentence describing a different question
       * than the one their session is actually asking.
       */
      const kind = typeof event === 'string' ? WAITING_KIND[event] : undefined;
      if (kind === undefined) return;

      const copy = WAITING_COPY[kind];
      hub.raise({
        kind,
        title: `${entityId} ${copy.title}`,
        body: copy.body,
        action,
      });
      return;
    }

    /**
     * A hook-driven `idle` is **not** "this session went quiet" (HIVE-75).
     *
     * `HOOK_STATUS` maps both `SessionStart` and `Stop` to `idle`, so without
     * this every session spawn announced "has gone quiet" the instant it
     * started — false on its face — and every agent turn announced it again.
     * None of them dedup, so a working hour of thirteen sessions filled the
     * buffer with idle rows and evicted the approval request the user actually
     * walked away from.
     *
     * The event this notification has always been about is the *pty* going
     * silent for `ACTIVITY_IDLE_MS`, which `activity.ts` derives and which
     * carries no hook event. That is the one kept.
     */
    if (status === 'idle' && event !== undefined) return;

    const kind = SESSION_KIND[status as DerivedStatus];
    if (kind === undefined) return;

    const terminated = kind === 'session.ended';
    hub.raise({
      kind,
      /**
       * "Ended", not "finished". The notification reports what main saw — the
       * process is gone — and claiming the *work* finished is the judgement
       * story 108 took out of this path.
       */
      title: terminated ? 'Session ended' : 'Session idle',
      body: terminated
        ? `${entityId} has exited.`
        : `${entityId} has gone quiet.`,
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
