import type { NotificationPrefs } from '../../shared/config-contract';
import { CH } from '../../shared/ipc-contract';
import type { DerivedStatus } from '../../shared/session-contract';

/**
 * OS notifications for the things you walked away from (story 106).
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
 * ## No focus suppression
 *
 * The obvious rule — stay quiet while the app is focused — is not implementable
 * *correctly* from here. Main cannot know which session the user is looking at;
 * `activeTab` is renderer state. The only version main could apply on its own is
 * "quiet whenever any window is focused", which would suppress precisely the
 * case this feature exists for: a background session finishing while the user
 * works in another terminal. The per-class switch is the control, and there is
 * no second, invisible one.
 *
 * ## Why the presenter is injected
 *
 * `Notification` is Electron's, and constructing one in a unit test needs a
 * running app. What is worth testing here is *which* events become a
 * notification, which is a decision this module makes on its own.
 */

/** Show one notification. The real one wraps Electron's `Notification`. */
export type NotificationPresenter = (options: {
  title: string;
  body: string;
  onClick: () => void;
}) => void;

export interface NotifierOptions {
  /**
   * Read at the moment of the event, never captured.
   *
   * A preference snapshot taken at boot would ignore every save the user makes
   * afterwards, and the settings section writes through main's config cache.
   */
  prefs: () => NotificationPrefs;
  present: NotificationPresenter;
  /** Tell the renderer to open this session. Main focuses the window itself. */
  activate: (entityId: string) => void;
}

export interface Notifier {
  /** Called for every main → renderer broadcast. Most are not event classes. */
  observe(channel: string, payload: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The two session statuses that are event classes. `working` is not one.
 *
 * The **preference key stays `sessionDone`** while the status it answers to is
 * now `terminated` (story 108). That asymmetry is deliberate: the key is written
 * into the user's config file, and renaming it would silently reset the
 * preference of everyone who had already turned it off. The status is an
 * in-memory observation and cost nothing to correct.
 */
const SESSION_CLASS: Partial<Record<DerivedStatus, keyof NotificationPrefs>> = {
  terminated: 'sessionDone',
  idle: 'sessionIdle',
};

export function createNotifier(options: NotifierOptions): Notifier {
  const { prefs, present, activate } = options;

  const sessionEvent = (payload: Record<string, unknown>): void => {
    const { entityId, status } = payload;
    if (typeof entityId !== 'string' || typeof status !== 'string') return;

    const key = SESSION_CLASS[status as DerivedStatus];
    if (key === undefined || !prefs()[key]) return;

    const terminated = status === 'terminated';
    present({
      /**
       * "Ended", not "finished". The notification reports what main saw — the
       * process is gone — and claiming the *work* finished is the judgement
       * story 108 took out of this path.
       */
      title: terminated ? 'Session ended' : 'Session idle',
      body: terminated
        ? `${entityId} has exited.`
        : `${entityId} has gone quiet.`,
      onClick: () => activate(entityId),
    });
  };

  const cloneEvent = (payload: Record<string, unknown>): void => {
    const { ok, reason } = payload;
    if (typeof ok !== 'boolean') return;
    if (!prefs().cloneDone) return;

    present({
      title: ok ? 'Clone finished' : 'Clone failed',
      body:
        ok || typeof reason !== 'string'
          ? 'The repository is ready.'
          : reason,
      /**
       * A clone has no session to open.
       *
       * Clicking still dismisses the notification, which is what the OS does
       * for free; inventing a destination — the settings pane, say — would take
       * the user somewhere they did not ask to go.
       */
      onClick: () => undefined,
    });
  };

  return {
    observe(channel, payload) {
      if (!isRecord(payload)) return;

      /**
       * Nothing here may throw.
       *
       * This runs inside the broadcast every session's output depends on. A
       * notification that failed must cost a missing notification, never a
       * missing `pty:data`.
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
