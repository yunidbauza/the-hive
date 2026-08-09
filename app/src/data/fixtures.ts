import type { Notification } from '@/types/notification';

/**
 * What the app still seeds at boot, and why it is only two arrays.
 *
 * This module used to carry the whole demo dataset ported from
 * `concept/Command Center.dc.html` — ten sessions, three agents, five projects,
 * eight tickets and an orchestrator banner. **That is gone.** The surfaces those
 * fed are now driven by the real thing: sessions come from PTYs the user starts,
 * projects from the config file, tickets from Jira, and the console transcript
 * from what the orchestrator actually does. A seeded session made the header
 * count fleet activity that did not exist, and a seeded ticket flashed on screen
 * for a frame before the Jira read replaced it — both of which read as bugs
 * because they were.
 *
 * **What remains is one slice: `notifs`.** It is seeded because nothing
 * produces it — there is no notification producer yet — and emptying it would
 * leave the inbox permanently blank with no path to filling it, which is a
 * worse lie than stale sample rows.
 *
 * There were three, and the other two left by different routes in the same
 * week. `feed` went with the Activity panel it fed; the right rail's third tab
 * is the project explorer now, and nothing was ever going to replace the feed
 * because the orchestrator's own transcript already answers "what did it just
 * do". `prs` went the opposite way — something real *did* arrive for it.
 *
 * **`prs` used to be here and is gone.** GitHub feeds that panel now — a sweep
 * of the configured project repositories through `gh`, on a poll — so a seeded
 * PR would be a fourth sample row sitting above a user's real ones, claiming a
 * repository they do not have. That is exactly the flash the seeded tickets
 * caused before HIVE-69 removed them.
 *
 * The one that remains is **knowingly stale**, and the consequence is precise
 * enough to write down. Its `target` fields name sessions (`lead-form`,
 * `call-notes`) that no longer exist in any store. `openEntity` passes an
 * unknown id through by design — it refuses *ended* sessions, and an id it has
 * never heard of is not one — so clicking one of these rows sets `activeTab` to
 * a phantom id, `resolve-view` routes back to the orchestrator, and `markRead`
 * still fires: the badge drops and nothing opens.
 *
 * That was an explicit call, not an oversight. The alternative — making the rows
 * non-interactive — would freeze a panel that is due to become real, and the
 * click still does the one useful thing it can, which is dismiss the row. It
 * dies the day something real feeds it, and this file dies with it.
 *
 * Nothing outside `src/stores/` may import this module — enforced by an import
 * zone (story 014), not by review. Panels read derived state through selector
 * hooks so there is exactly one source of truth for every number on screen.
 */

/** The slices that still have no live producer. */
export interface InitialState {
  notifs: Notification[];
}

/**
 * A factory rather than a frozen object: every test starts from a clean copy,
 * so mutating one test's state cannot leak into the next (story 013).
 */
export function createInitialState(): InitialState {
  return {
    notifs: [
      {
        icon: 'ph-hand-palm',
        tone: 'amber',
        title: 'lead-form needs approval',
        sub: 'prisma migrate dev — lead_phone_idx',
        time: '4m',
        unread: true,
        target: 'lead-form',
      },
      {
        icon: 'ph-chat-circle-dots',
        tone: 'amber',
        title: 'call-notes asked a question',
        sub: 'Immutable notes vs 24h edit window',
        time: '12m',
        unread: true,
        target: 'call-notes',
      },
      {
        icon: 'ph-git-pull-request',
        tone: 'green',
        title: 'PR #219 approved',
        sub: 'pr-reviewer · referral-api/partner-webhooks',
        time: '26m',
        unread: true,
        target: 'webhooks',
      },
      {
        icon: 'ph-slack-logo',
        tone: 'brand',
        title: 'Mention in #ask-eng',
        sub: 'slack-agent answered, thread linked',
        time: '41m',
        unread: false,
        target: 'slack-agent',
      },
      {
        icon: 'ph-check-circle',
        tone: 'green',
        title: 'PR #77 merged',
        sub: 'advisor-portal · tour timezone fix',
        time: '1h',
        unread: false,
        target: 'tz-fix',
      },
    ],
  };
}
