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
 * ## Why `session.input_needed` is a second waiting kind
 *
 * `session.blocked` covers a session blocked *mid-turn* — a tool wants a yes,
 * an MCP server wants a sentence, or the `AskUserQuestion` tool wants words.
 * It does not cover the commonest way a session ends up waiting on a human:
 * the turn finished and nobody typed. That is not a question and not an
 * approval; nothing was asked, and the session is simply done talking and out
 * of instructions.
 *
 * It had no producer until story 106 because there was no event to hang it on.
 * `Stop` is not it — `Stop` fires at the end of *every* turn, including the many
 * the user is sitting and watching, and a row per turn is the notification
 * stream nobody trusts. Claude's `Notification/idle_prompt` fires sixty seconds
 * after `Stop` with nobody having typed, and that debounce is exactly the
 * difference between "the turn ended" and "you walked away". Measured, not
 * assumed — see `hook-contract.ts`.
 *
 * ## Why `session.waiting` and `session.asked` became one kind (HIVE-83)
 *
 * Both used to map to the *status* `waiting` and were kept as two notification
 * kinds on the theory that "approve this command" and "answer this question"
 * ask different things and carry different urgency. In practice the split did
 * not survive measurement: `session.asked` was wired only to `Elicitation` —
 * MCP elicitation, which effectively never fires — while the real question
 * case, the `AskUserQuestion` tool, arrived as `PermissionRequest` and so wore
 * "needs approval" copy regardless. Two switches nobody could toggle
 * independently, because one of them never lit up. See `session.blocked`'s own
 * entry in {@link NOTIFICATION_KIND_SPECS} for the fuller argument.
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
  'session.blocked',
  'session.idle',
  'session.input_needed',
  'clone.done',
  'pr.approved',
  'pr.merged',
  'pr.checks_failed',
  'pr.review_requested',
  'agent.ask',
  'agent.permission',
  'agent.done',
  'agent.failed',
  'app.update_available',
  'app.update_ready',
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
  | { type: 'url'; url: string }
  /**
   * Answer this ask in place (HIVE-118).
   *
   * Carries the thread and **nothing else** — not the options, not the body.
   * The ledger entry already states them, and a copy here is a second version
   * of the same fact that can disagree with the first: a card rebuilt from a
   * stale action would draw buttons the ask no longer offers.
   */
  | { type: 'ask'; thread: string }
  /**
   * Open this agent's view on the centre stage (HIVE-118).
   *
   * Its own member rather than reusing `session`, even though an agent's
   * entity id *is* its name: the `session` branch resolves through
   * `currentRowFor`, which means "the row this **terminal** id names now". An
   * agent has no terminal, so reusing it would work by accident.
   */
  | { type: 'agent'; name: string }
  /**
   * Start downloading the update this notification announced.
   *
   * Carries no version. The updater already knows which release it found, and a
   * version on the action would be a second copy of that fact that could
   * disagree with it — a stale row clicked an hour later would ask for a
   * download of something the updater has since moved past.
   */
  | { type: 'update.download' }
  /** Quit and swap in the update that has finished downloading. */
  | { type: 'update.install' };

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
  /**
   * The row's words, **without the name of whatever it is about**.
   *
   * When {@link subject} is set this is the predicate alone — `is yours again`,
   * `asked a question` — and the reader prefixes the subject's current name.
   * When it is absent this is the whole title, as it always was.
   */
  title: string;
  /**
   * The session this row is about, as a **terminal** id, or absent when the row
   * is about no session at all (`pr.*`, `clone.done`, `app.update_*`).
   *
   * ## Why the name is not simply written into the title
   *
   * Because a notification outlives the name it was raised under. Main used to
   * compose `` `${name} ${predicate}` `` at raise time, which froze two things
   * that both move:
   *
   * - **The name arrives later.** Since HIVE-108 a session opens *unnamed* and
   *   Claude titles it from the conversation some turns in. Every row raised
   *   before that said `sess-11` and could never catch up, which is the bug
   *   this field closes.
   * - **Main's copy of the name was never the rail's.** Main sees the raw OSC
   *   title; the rail's name is that title through `hiveNameFromTitle` plus
   *   rules that live in the store — the pinned-ticket prefix, HIVE-109's `-2`
   *   collision numbering, the stale-title guard, `/clear` successor targeting.
   *   A row and the rail naming one session two different things is the same
   *   confusion in a subtler form.
   *
   * So the name is **derived, never carried** — the rule this file already
   * states for `icon`, `tone` and the relative time, applied to the last field
   * that broke it. The inbox row resolves it from the store at render time; the
   * desktop toast, which is a moment rather than a record, resolves it once
   * from main's own map when it is presented.
   *
   * A **terminal** id, not a row id, for the reason `NotificationAction`'s own
   * `session` member gives: main speaks terminal ids, and the renderer maps one
   * to the row it names *now* with `currentRowFor`. That is what keeps the words
   * on the row and the destination of its click describing one session.
   */
  subject?: string;
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
  /**
   * One switch for every way a session blocks on a human (HIVE-83).
   *
   * This was two kinds, and the split did not survive measurement.
   * `session.asked` was wired only to `Elicitation` — MCP elicitation, which
   * effectively never fires — while the real question case, the
   * `AskUserQuestion` tool, arrives as `PermissionRequest` and so wore
   * "needs approval" copy. Routing them apart properly is now possible, but it
   * would buy two switches nobody toggles independently.
   *
   * The **row** still varies its title and body by cause. The glyph does not:
   * `icon` is a property of the kind and never stored on a notification, and
   * one kind means one glyph. The words carry the difference.
   */
  'session.blocked': {
    source: 'session',
    label: 'When a session is blocked on you',
    description:
      'A tool wants approval, or an agent asked a question and cannot carry on. Includes subagents.',
    icon: 'ph-hand-palm',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  /**
   * The turn actually ended: idle with **nothing left running** (HIVE-89).
   *
   * Not the `session.idle` HIVE-83 retired. That one was pty-derived — "the
   * output paused" — and never fired for a Claude session because the
   * `hookDriven` gate blocked it; this one is raised by the notifier off the
   * tracker's own verdict, and only on the transition into an idle that has
   * no `idleDetail` behind it. A background agent or a background shell still
   * running is not the user's turn, and the tracker has told those apart since
   * HIVE-83 / HIVE-84.
   *
   * An **edge**, not a level, and that is the design decision. The moment is
   * reached by the `Stop` that ends a turn with nothing outstanding — which,
   * measured, is also how a subagent finishing or a background shell ending
   * after the turn arrives: Claude Code re-invokes the agent to collect the
   * result and that turn ends in a `Stop` of its own. Those later cases are
   * why this is a kind of its own rather than a tighter filter on
   * `session.input_needed`: `idle_prompt` is a sixty-second timer that starts
   * at the end of the turn, so it cannot describe a background agent
   * finishing twenty minutes later.
   *
   * `both`, because this is the fact the user walked away to wait for.
   */
  'session.idle': {
    source: 'session',
    label: 'When a session becomes yours again',
    description:
      'Its turn ended and nothing is left running — no background agent, no background script. The moment it stopped working.',
    icon: 'ph-moon',
    tone: 'brand',
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
     * `inbox`, not `both` — and not `off` either.
     *
     * What makes this kind chatty is the toast, not the row. `off` would also
     * take away the row, and the row is the record that a minute passed with
     * nothing typed. Since HIVE-89 the moment work actually *stopped* has a
     * kind of its own (`session.idle`, `both`), and this one is gated off the
     * same `idleDetail`: it no longer fires while a background agent or script
     * is still working. `inbox` kills the interruption and keeps the nudge.
     */
    defaultDelivery: 'inbox',
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
  'app.update_available': {
    source: 'app',
    label: 'When a new version is available',
    description:
      'A newer release of The Hive has been published. Nothing happens until you say so.',
    icon: 'ph-arrow-circle-up',
    tone: 'brand',
    /**
     * `both`, and it is the least chatty kind in this registry.
     *
     * The producer is capped by the version itself: a given release announces
     * itself once per running app, no matter how often the checker looks,
     * because the dedup id is the version string. So `both` costs exactly one
     * toast per release — which is roughly one a week at this project's pace,
     * and is the notification a user most plausibly wants pulled out of a panel
     * they were not looking at.
     */
    defaultDelivery: 'both',
  },
  'app.update_ready': {
    source: 'app',
    label: 'When an update is ready to install',
    description:
      'The download finished. Clicking it restarts the app on the new version.',
    icon: 'ph-arrow-clockwise',
    tone: 'green',
    /**
     * `both`, because this one interrupts on purpose.
     *
     * The user asked for the download and then went back to work. The whole
     * point of not auto-installing is that the restart happens when *they* say
     * — and a restart prompt that waits silently in a panel is a download that
     * never lands.
     *
     * It cannot repeat: a download completes once per version per launch.
     */
    defaultDelivery: 'both',
  },
  /**
   * The one kind that is answered rather than opened (HIVE-118).
   *
   * `both`, because an ask is a party waiting on you: an agent that asked has
   * ended its turn and is doing nothing until you answer, so a card the user
   * only finds on their next glance at the rail is a stalled agent.
   */
  'agent.ask': {
    source: 'agent',
    label: 'When an agent or session asks you something',
    description: 'An agent or session is asking you something.',
    icon: 'ph-chat-circle-dots',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  /**
   * An ask whose subject is a tool call (HIVE-119 produces these).
   *
   * Its own kind rather than a flavour of `agent.ask` so it can be silenced
   * separately: a user who wants every question can still decide that
   * permission prompts are the ones worth an OS notification, or the reverse.
   */
  'agent.permission': {
    source: 'agent',
    label: 'When an agent needs permission to use a tool',
    description: 'An agent wants to use a tool its definition does not grant.',
    icon: 'ph-hand-palm',
    tone: 'amber',
    defaultDelivery: 'both',
  },
  /**
   * `inbox`, not `both`.
   *
   * A finished agent is good news and nothing is waiting on the user, so it
   * belongs where they will find it rather than in front of what they were
   * doing. This is the same reasoning `clone.done` uses.
   */
  'agent.done': {
    source: 'agent',
    label: 'When an agent finishes something',
    description: 'An agent reported what it did. An uneventful wake says nothing.',
    icon: 'ph-check-circle',
    tone: 'green',
    defaultDelivery: 'inbox',
  },
  /**
   * `both`, and deliberately covering three different endings.
   *
   * A run stopped by `limits.turns` or `limits.budget` is a cap the user set
   * and can raise; a `failed` is something going wrong. Both are things the
   * user would otherwise learn only by noticing an agent had gone quiet.
   */
  'agent.failed': {
    source: 'agent',
    label: 'When an agent fails or hits a limit',
    description:
      'A run ended badly — it failed, ran out of turns, spent its budget, or could not hand off its session.',
    icon: 'ph-warning',
    tone: 'red',
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
 * The one boolean this shape replaced that still has somewhere to land.
 *
 * `sessionDone` and `sessionIdle` used to migrate into `session.ended` and
 * `session.idle`. HIVE-83 retired both kinds outright, and HIVE-89 brought
 * `session.idle` back under a **different meaning** — "the turn actually
 * ended", not "the output paused" — so `sessionIdle` is deliberately not
 * re-pointed at it: a boolean that once gated a pause-toast says nothing about
 * whether the user wants to hear that their turn is over. Only `cloneDone`
 * still has a target. `sessionDone` and `sessionIdle` remain accepted, below,
 * for the config file that still names them; they simply have nothing to write.
 *
 * The care this map has always taken is still owed to the one entry left in
 * it: `config-contract.ts` already went out of its way once not to reset
 * anyone's preference, and a user who turned clone notifications off before
 * this story must not find them back on after it.
 */
const LEGACY_KEYS: Record<string, NotificationKind> = {
  cloneDone: 'clone.done',
};

/**
 * Keys this build no longer writes but must still accept.
 *
 * `checkKeys` discards the **whole** notifications block on an unrecognised
 * key, so a config naming a retired kind would silently reset every other
 * notification preference the user had set. The three pre-HIVE-75 booleans are
 * here for the same reason; HIVE-83 added the four kinds it merged or removed.
 *
 * `session.idle` left this list in HIVE-89, because it is a live kind again.
 * A config that still holds a HIVE-75-era delivery for it is read as the
 * user's choice for the revived kind — the key is the same, the value is a
 * valid delivery, and "preserve what the user chose" is the rule every other
 * entry here follows. A user who silenced the old pause-toast finds the new
 * kind quiet too, which is the conservative direction to be wrong in.
 */
export const LEGACY_NOTIFICATION_KEYS: readonly string[] = [
  'sessionDone',
  'sessionIdle',
  'cloneDone',
  'session.waiting',
  'session.asked',
  'session.ended',
];

/**
 * `session.waiting` and `session.asked` merged into `session.blocked`
 * (HIVE-83, see `NOTIFICATION_KINDS`'s doc). Both retired keys held a
 * `NotificationDelivery`, not a boolean, so they migrate alongside
 * {@link LEGACY_KEYS} rather than through it.
 *
 * Taking the **quieter** of the two when both are present — `off` beats
 * `inbox` beats `both`, in {@link NOTIFICATION_DELIVERIES}'s own order —
 * keeps the promise the rest of this function's docs make about a legacy
 * value: it is read to *preserve* what the user chose, not to loosen it. A
 * user who had silenced either the approval prompts or the questions must
 * not find the merged switch back on because the other one was still loud.
 */
export const RETIRED_SESSION_KEYS = ['session.waiting', 'session.asked'] as const;

/**
 * Resolve what the file said into what the hub reads.
 *
 * Three inputs, in increasing precedence: registry defaults, then any legacy
 * value (boolean or retired per-kind delivery), then any current per-kind
 * value. So a file holding more than one shape — which is what a
 * downgrade-then-upgrade produces — answers with the newest one, and a file
 * holding none of them answers with the defaults.
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

  const retiredDeliveries = RETIRED_SESSION_KEYS.map((key) => record[key]).filter(
    isNotificationDelivery,
  );
  if (retiredDeliveries.length > 0) {
    resolved['session.blocked'] = retiredDeliveries.reduce((quietest, candidate) =>
      NOTIFICATION_DELIVERIES.indexOf(candidate) < NOTIFICATION_DELIVERIES.indexOf(quietest)
        ? candidate
        : quietest,
    );
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
