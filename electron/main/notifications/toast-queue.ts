import type {
  NotificationKind,
  ToastPayload,
} from '@shared/notification-contract';

/**
 * Toasts raised while nobody was looking, held for whoever attaches next
 * (HIVE-145).
 *
 * ## What this is not
 *
 * Not a notification queue. No *row* is ever lost by not queueing: the hub's
 * buffer outlives every surface and the attach snapshot carries it, so a device
 * that joins a server it has been away from renders the whole inbox. What is
 * lost without this is the **interruption** — the toast fired into an empty
 * room — and that is all this holds.
 *
 * ## Why it is filtered rather than faithful
 *
 * Replaying everything would be the literal reading of "queue rather than fire
 * into an empty room", and it would be a worse product. A mini left serving
 * overnight raises PR results, agent completions and update notices; attaching
 * in the morning would produce a burst of toasts about things already in the
 * inbox, and a notification stream the user stops trusting is worse than no
 * notifications at all — which is the reasoning `NOTIFICATION_KIND_SPECS`
 * already uses to default the chatty kinds to `inbox`.
 *
 * So three bounds, each answering a different way the queue could become noise:
 *
 * - **Kind** — only what a person must answer. Everything else is a record,
 *   and the inbox is where records go.
 * - **Age** — a question that went stale overnight has usually been answered,
 *   abandoned, or overtaken. Interrupting about it at breakfast is a false
 *   alarm with a timestamp.
 * - **Subject** — one busy session asking four times is one thing to look at,
 *   so the newest wins and the rest are dropped.
 */

/**
 * The kinds worth interrupting for on a delayed delivery.
 *
 * Each of these is a session or an agent that has **stopped and is waiting for
 * a human**. That is the property, not "important": a failed agent run matters
 * a great deal and is not here, because nothing is blocked on the user reading
 * it in the next few seconds and the inbox row says it just as well.
 */
export const TOAST_QUEUE_KINDS: readonly NotificationKind[] = [
  'session.blocked',
  'session.input_needed',
  'agent.ask',
  'agent.permission',
];

/**
 * How many held toasts to keep. Small on purpose: this is a list of things to
 * interrupt someone with the moment they arrive, and a screenful of
 * interruptions is not one.
 */
const CAP = 8;

/**
 * How long a held toast stays worth raising.
 *
 * Thirty minutes: long enough to cover stepping out, short enough that a
 * question raised before bed does not interrupt breakfast. Past it the row is
 * still in the inbox, which is the honest place for something that has been
 * waiting that long.
 */
const TTL_MS = 30 * 60 * 1000;

export interface ToastQueue {
  /** Hold this one, if it is the kind worth holding. */
  push(payload: ToastPayload): void;
  /** Everything still worth raising, oldest first. Empties the queue. */
  flush(): ToastPayload[];
  size(): number;
  clear(): void;
}

/**
 * What counts as "the same thing" for coalescing.
 *
 * The subject rather than the notification: two `session.blocked` rows about
 * one session are one thing the user needs to look at. An action that names no
 * subject falls back to the id, which coalesces nothing — correct, because
 * there is nothing to say those two are about the same thing.
 */
function subjectOf(payload: ToastPayload): string {
  const { action } = payload;
  switch (action.type) {
    case 'session':
      return `session:${action.entityId}`;
    case 'ask':
      return `ask:${action.thread}`;
    case 'agent':
      return `agent:${action.name}`;
    default:
      return `id:${payload.id}`;
  }
}

export function createToastQueue(
  options: { now?: () => number; cap?: number; ttlMs?: number } = {},
): ToastQueue {
  const { now = () => Date.now(), cap = CAP, ttlMs = TTL_MS } = options;

  /** Insertion-ordered, so the first entry is the oldest. */
  const held = new Map<string, { payload: ToastPayload; at: number }>();

  return {
    push(payload) {
      if (!TOAST_QUEUE_KINDS.includes(payload.kind)) return;

      const subject = subjectOf(payload);
      // Re-inserted rather than updated in place, so the newest is also the
      // newest in iteration order and the cap drops genuinely stale entries.
      held.delete(subject);
      held.set(subject, { payload, at: now() });

      while (held.size > cap) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
    },

    flush() {
      const cutoff = now() - ttlMs;
      const live: ToastPayload[] = [];
      for (const { payload, at } of held.values()) {
        if (at >= cutoff) live.push(payload);
      }
      held.clear();
      return live;
    },

    size: () => held.size,
    clear: () => { held.clear(); },
  };
}
