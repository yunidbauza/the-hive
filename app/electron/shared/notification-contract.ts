/**
 * What the app is willing to interrupt someone for (HIVE-75).
 *
 * Types and constants only — both processes import this.
 *
 * ## Why this replaced a view-model
 *
 * The shape this supersedes lived in `src/types/notification.ts` and was pure
 * presentation: `{ icon, tone, title, sub, time, unread, target }`. It had no
 * id, no kind, no timestamp and no payload, which meant nothing could be
 * sorted, deduped, aged, routed or subscribed to — and `time` was the literal
 * string `"4m"`, so every seeded row was permanently four minutes old.
 *
 * That was fine while the inbox was a fixture. It stops being fine the moment
 * something real produces one.
 *
 * ## Presentation is derived, never carried
 *
 * `icon` and `tone` are **not** fields on {@link HiveNotification}. They come
 * from {@link NOTIFICATION_KIND_SPECS}, keyed by kind, and the relative time
 * comes from `createdAt`. That is the codebase's own rule — derived values are
 * computed in selectors, never stored — applied to the one slice that used to
 * break it. A stored icon is a second source of truth for a fact the kind
 * already determines, and a stored `"4m"` is a clock that stopped.
 *
 * ## Why the registry is the only place a kind is declared
 *
 * Adding a notification used to mean touching the contract, the settings pane,
 * the store and the main process. Everything a consumer needs is on the spec
 * here instead — the label and description the settings section renders, the
 * icon and tone the card renders, and the delivery it defaults to — so a new
 * kind gets its switch, its glyph and its default for free.
 *
 * The test of that is mechanical: `notifications-section.tsx` iterates this
 * record and renders one control per entry. A kind that is not here has no UI,
 * and a kind that is here cannot be forgotten by it.
 */

/** The colour a card's glyph is painted in. Semantic, never a palette literal. */
export type Tone = 'amber' | 'green' | 'brand' | 'red';

/**
 * Where a notification came from. Groups the settings section, nothing more.
 *
 * Deliberately coarser than {@link NotificationKind}: the user thinks in
 * "sessions" and "GitHub", and a settings pane with one flat list of ten
 * switches is a settings pane nobody reads to the bottom of.
 */
export type NotificationSource = 'session' | 'github' | 'agent' | 'app';

/**
 * Every kind of thing the app will raise.
 *
 * ## Why `session.input_needed` is a third waiting kind
 *
 * The two below cover a session blocked *mid-turn* — a tool wants a yes, an MCP
 * server wants a sentence. Neither covers the commonest way a session ends up
 * waiting on a human: the turn finished and nobody typed. That is not a
 * question and not an approval; nothing was asked, and the session is simply
 * done talking and out of instructions.
 *
 * It had no producer until this story because there was no event to hang it on.
 * `Stop` is not it — `Stop` fires at the end of *every* turn, including the many
 * the user is sitting and watching, and a row per turn is the notification
 * stream nobody trusts. Claude's `Notification/idle_prompt` fires sixty seconds
 * after `Stop` with nobody having typed, and that debounce is exactly the
 * difference between "the turn ended" and "you walked away". Measured, not
 * assumed — see `hook-contract.ts`.
 *
 * ## Why `session.waiting` and `session.asked` are two kinds
 *
 * Both map to the *status* `waiting` — `hook-contract.ts` maps
 * `PermissionRequest` and `Elicitation` to it precisely because they are "the
 * same fact about the session". They are not the same fact about the **user**.
 * "Approve this command" and "answer this question" ask different things and
 * carry different urgency, and the concept mock shows them as two distinct rows
 * with two distinct glyphs. A status collapses them; a notification must not.
 *
 * ## Why there is no `slack.*` here yet
 *
 * Slack is HIVE-77 and has no producer in this build. Registering the kind now
 * would put a switch in the settings pane that silently does nothing, which is
 * the exact failure story 106 named when it refused to ship a `waiting` switch
 * ahead of the hook that could raise it. **Absent rather than disabled**, and
 * absent rather than inert.
 */
export const NOTIFICATION_KINDS = [
  'session.waiting',
  'session.asked',
  'session.input_needed',
  'session.ended',
  'session.idle',
  'clone.done',
  'pr.approved',
  'pr.merged',
  'pr.checks_failed',
  'pr.review_requested',
  'agent.custom',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Whether a string names a kind this build knows. */
export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' &&
  (NOTIFICATION_KINDS as readonly string[]).includes(value);

/**
 * How far a notification travels.
 *
 * Three states rather than a boolean, because "show me when I look" and
 * "interrupt me" are genuinely different asks and the old switches could only
 * express the second. Today every event that passes the boolean lands in both
 * places; a user who wants a record of idle sessions without a desktop toast
 * has no way to say so.
 */
export type NotificationDelivery = 'off' | 'inbox' | 'both';

export const NOTIFICATION_DELIVERIES: readonly NotificationDelivery[] = [
  'off',
  'inbox',
  'both',
];

export const isNotificationDelivery = (
  value: unknown,
): value is NotificationDelivery =>
  typeof value === 'string' &&
  (NOTIFICATION_DELIVERIES as readonly string[]).includes(value);

/**
 * What clicking a notification does.
 *
 * A discriminated union rather than the old bare `target: string`, which could
 * only ever mean "an entity id" and had no way to say "there is nowhere to go".
 * A clone has no session to open, and the previous shape had to encode that as
 * an id that resolved to nothing.
 */
export type NotificationAction =
  | { type: 'none' }
  /** Open this session's tab. `entityId` is a **terminal** id — see `currentRowFor`. */
  | { type: 'session'; entityId: string }
  /** Open this URL in the user's browser. */
  | { type: 'url'; url: string };

/** One thing that wants the user's attention. */
export interface HiveNotification {
  /**
   * Stable, and the dedup key.
   *
   * Producers mint it from something the *event* already identifies — a PR
   * number and its new state, a Slack event id — rather than from a counter, so
   * that a producer which re-delivers is a producer that is safe. A poller that
   * sees the same transition twice must not say it twice.
   */
  id: string;
  kind: NotificationKind;
  title: string;
  /** The second line. May be empty; the card simply renders nothing. */
  body: string;
  /** Epoch ms. The relative time on the card is derived from this, and ticks. */
  createdAt: number;
  unread: boolean;
  action: NotificationAction;
}

/** Everything any consumer needs to know about a kind. */
export interface NotificationKindSpec {
  source: NotificationSource;
  /** The settings switch label. Sentence case, no trailing period. */
  label: string;
  /** The line under it. Says what the event *is*, not what the switch does. */
  description: string;
  /** A `ph-*` name as `src/components/ui/icon.tsx` spells it. */
  icon: string;
  tone: Tone;
  defaultDelivery: NotificationDelivery;
}

/**
 * The registry. One entry per kind, and the only declaration of one.
 *
 * ## How the defaults were chosen
 *
 * `both` is for events the user walked away from and would want interrupting
 * for; `inbox` is for events that are real but chatty. Story 106 already made
 * this call for the three it had — idle is off by default there because "a
 * build that pauses to download is not news, and a notification stream the user
 * stops trusting is worse than no notifications at all".
 *
 * That reasoning survives intact, and so does its answer: idle stays `off`. The
 * boolean split makes `inbox` *expressible*, which is not the same as making a
 * two-second pause worth a row — and a registered kind defaulted to `off` is
 * still discoverable, because the settings pane lists every kind whether or not
 * it is switched on. Nothing is hidden by the default; it is only quiet.
 */
export const NOTIFICATION_KIND_SPECS: Record<
  NotificationKind,
  NotificationKindSpec
> = {
  'session.waiting': {
    source: 'session',
    label: 'When a session needs approval',
    description:
      'A tool is waiting on you to allow it. The session is blocked until you answer.',
    icon: 'ph-hand-palm',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  'session.asked': {
    source: 'session',
    label: 'When a session asks a question',
    description:
      'An agent needs an answer before it can carry on. Blocked, like an approval, but it wants words rather than a yes.',
    icon: 'ph-chat-circle-dots',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  'session.input_needed': {
    source: 'session',
    label: 'When a session runs out of instructions',
    description:
      'Its turn ended and a minute passed with nothing typed. Not a question — it has simply finished and is waiting on you.',
    icon: 'ph-keyboard',
    tone: 'amber',
    /**
     * `both`, and the argument for it is narrower than it first looks.
     *
     * The tempting version — "the sixty-second debounce proves the user is not
     * looking, so a toast is always warranted" — is **wrong, and worth writing
     * down so nobody re-derives it.** Claude's debounce measures typing into
     * *that session*, not the user's presence. In a fleet only one terminal has
     * focus at a time, so a session the user read and deliberately moved on
     * from reaches sixty seconds exactly as a session they walked away from
     * does, and the app cannot tell the two apart — there is no focus
     * suppression anywhere in this pipeline, on purpose (see
     * `notifications/index.ts`).
     *
     * What actually carries the default is the **shape of the repeat**, not the
     * debounce. `session.input_needed` is announced once per stretch of
     * waiting: the notifier suppresses it until the session has visibly stopped
     * waiting, so a parked session costs one toast, not one a minute and not
     * one per turn. That is the whole distance between this and `Stop`, which
     * has no such cap and would fire on every turn including the watched ones.
     *
     * The honest cost, then: a user working across a dozen sessions gets a
     * toast for each one they leave alone for a minute — once each. That is
     * loud on a busy afternoon and precisely right at the end of one, and the
     * per-kind control exists so the judgement is theirs rather than this
     * record's. Defaulting quiet would answer the bug this kind was added for —
     * "my session was waiting and nothing told me" — with a row in a panel
     * nobody had open.
     */
    defaultDelivery: 'both',
  },
  'session.ended': {
    source: 'session',
    label: 'When a session finishes',
    description: 'Its process exited — the thing you walked away from is done.',
    icon: 'ph-terminal',
    tone: 'brand',
    defaultDelivery: 'both',
  },
  'session.idle': {
    source: 'session',
    label: 'When a session goes quiet',
    description:
      'No output for a couple of seconds. Real, but chatty: a build that pauses to download is not news.',
    icon: 'ph-moon',
    tone: 'brand',
    /**
     * Off, exactly as story 106 had it.
     *
     * The first cut of HIVE-75 promoted this to `inbox` on the reasoning that
     * `off` and `inbox` used to be the same thing — true, but it changed a
     * default the previous story had argued for on evidence: "a build that
     * pauses to download is not news, and a notification stream the user stops
     * trusting is worse than no notifications at all". Nothing about splitting
     * the boolean makes a two-second pause more interesting than it was.
     */
    defaultDelivery: 'off',
  },
  'clone.done': {
    source: 'app',
    label: 'When a clone finishes',
    description: 'Succeeded or failed. Long, and usually unattended.',
    icon: 'ph-download-simple',
    tone: 'brand',
    defaultDelivery: 'both',
  },
  'pr.approved': {
    source: 'github',
    label: 'When a pull request is approved',
    description: 'Someone signed off. Usually the last thing before it lands.',
    icon: 'ph-git-pull-request',
    tone: 'green',
    defaultDelivery: 'both',
  },
  'pr.merged': {
    source: 'github',
    label: 'When a pull request merges',
    description: 'It landed. Confirmation rather than a call to act.',
    icon: 'ph-check-circle',
    tone: 'green',
    defaultDelivery: 'inbox',
  },
  'pr.checks_failed': {
    source: 'github',
    label: 'When checks start failing',
    description: 'CI went red on a pull request that was passing or pending.',
    icon: 'ph-x-circle',
    tone: 'red',
    defaultDelivery: 'both',
  },
  'pr.review_requested': {
    source: 'github',
    label: 'When a review is requested',
    description: 'Someone is waiting on you to look at their pull request.',
    icon: 'ph-git-pull-request',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  'agent.custom': {
    source: 'agent',
    label: 'When a background agent raises something',
    description:
      'Anything posted to the local notify endpoint that did not name a kind of its own.',
    icon: 'ph-robot',
    tone: 'brand',
    defaultDelivery: 'both',
  },
};

/** The kinds a source owns, in registry order. Groups the settings section. */
export const kindsForSource = (
  source: NotificationSource,
): NotificationKind[] =>
  NOTIFICATION_KINDS.filter(
    (kind) => NOTIFICATION_KIND_SPECS[kind].source === source,
  );

/**
 * The sources that have at least one kind, in the order the settings pane shows
 * them. Sessions first: they are the only ones that block a human.
 */
export const NOTIFICATION_SOURCE_ORDER: readonly NotificationSource[] = [
  'session',
  'github',
  'agent',
  'app',
];

/** Group headings. The pane never spells a source name itself. */
export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  session: 'Sessions',
  github: 'Pull requests',
  agent: 'Background agents',
  app: 'The app',
};

/**
 * What the config file may hold. Partial: an absent kind means its default.
 *
 * Stored partial rather than resolved so the write path can tell "the user
 * chose this" from "the file said nothing", which is what keeps an untouched
 * config from growing a block it never asked for — the rule `parse.ts` already
 * states for every other block.
 */
export type NotificationPrefs = Partial<
  Record<NotificationKind, NotificationDelivery>
>;

/** Every kind at its registry default. */
export function defaultNotificationPrefs(): Required<NotificationPrefs> {
  const prefs = {} as Required<NotificationPrefs>;
  for (const kind of NOTIFICATION_KINDS) {
    prefs[kind] = NOTIFICATION_KIND_SPECS[kind].defaultDelivery;
  }
  return prefs;
}

/**
 * The three booleans this shape replaced.
 *
 * They are in users' config files right now, and `config-contract.ts` already
 * went out of its way once not to reset anyone's preference: `sessionDone` is
 * *deliberately* misnamed relative to the status it answers to, because
 * "renaming it would silently reset the preference of everyone who had already
 * turned it off".
 *
 * The same care is owed here, and it costs about twenty lines. A user who
 * turned session notifications off before this story must not find them back on
 * after it.
 */
const LEGACY_KEYS: Record<string, NotificationKind> = {
  sessionDone: 'session.ended',
  sessionIdle: 'session.idle',
  cloneDone: 'clone.done',
};

/**
 * The legacy key names, for the reader that has to tolerate them.
 *
 * `parse.ts` reports unknown keys, and a config written before this story holds
 * all three — so without this list a file the app understands perfectly well
 * would raise three errors in the settings pane on the way to being migrated
 * correctly.
 */
export const LEGACY_NOTIFICATION_KEYS: readonly string[] = Object.keys(LEGACY_KEYS);

/**
 * Resolve what the file said into what the hub reads.
 *
 * Three inputs, in increasing precedence: registry defaults, then any legacy
 * boolean, then any per-kind value. So a file holding both shapes — which is
 * what a downgrade-then-upgrade produces — answers with the newer one, and a
 * file holding neither answers with the defaults.
 *
 * A legacy `true` becomes `both` rather than `inbox`, because `both` is what it
 * used to mean: the boolean gated an OS notification, and there was no inbox
 * delivery to opt out of separately.
 */
export function resolveNotificationPrefs(
  raw: unknown,
): Required<NotificationPrefs> {
  const resolved = defaultNotificationPrefs();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return resolved;
  }

  const record = raw as Record<string, unknown>;

  for (const [legacy, kind] of Object.entries(LEGACY_KEYS)) {
    const value = record[legacy];
    if (typeof value === 'boolean') resolved[kind] = value ? 'both' : 'off';
  }

  for (const kind of NOTIFICATION_KINDS) {
    const value = record[kind];
    if (isNotificationDelivery(value)) resolved[kind] = value;
  }

  return resolved;
}

/**
 * How many notifications are kept, in the hub and in the store alike.
 *
 * It lives in the contract because **both** processes bound the same list and a
 * disagreement is silently wrong in one direction: a renderer cap below the
 * hub's would drop rows that a later hydration brings straight back, so the
 * inbox would appear to un-forget things.
 *
 * Fifty rather than the renderer's old eight. Eight was an honest bet for a
 * seeded list that never grew; with real producers a busy afternoon would push
 * an approval request off the end before the user got back to their desk, which
 * is the one outcome this surface exists to prevent.
 */
export const NOTIFICATION_CAP = 50;
