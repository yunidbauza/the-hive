import type { Notification } from '@/types/notification';
import type { Pr } from '@/types/pull-request';

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
 * What remains is the two slices with no live source yet. `prs` and `notifs`
 * are seeded because nothing produces them: there is no PR poller and no
 * notification producer. Emptying them would leave two panels permanently blank
 * with no path to filling them, which is a worse lie than stale sample rows.
 *
 * There were three. `feed` is gone with the Activity panel it fed — the right
 * rail's third tab is the project explorer now. It is the one slice here that
 * died without something real replacing it, because nothing was ever going to:
 * the orchestrator's own transcript already answers "what did it just do", and
 * the feed was a second, invented telling of the same thing.
 *
 * They are **knowingly stale**, and the consequence is precise enough to write
 * down. Their `session` and `target` fields name sessions (`hero-refresh`,
 * `lead-form`) that no longer exist in any store. `openEntity` passes an unknown
 * id through by design — it refuses *ended* sessions, and an id it has never
 * heard of is not one — so clicking one of these rows sets `activeTab` to a
 * phantom id, `resolve-view` routes back to the orchestrator, and `markRead`
 * still fires: the badge drops and nothing opens.
 *
 * That was an explicit call, not an oversight. The alternative — making the rows
 * non-interactive — would freeze a panel that is due to become real, and the
 * click still does the one useful thing it can, which is dismiss the row. Each
 * of these two dies the day something real feeds it, and this file dies with
 * the last of them.
 *
 * Nothing outside `src/stores/` may import this module — enforced by an import
 * zone (story 014), not by review. Panels read derived state through selector
 * hooks so there is exactly one source of truth for every number on screen.
 */

/** The slices that still have no live producer. */
export interface InitialState {
  prs: Pr[];
  notifs: Notification[];
}

/**
 * A factory rather than a frozen object: every test starts from a clean copy,
 * so mutating one test's state cannot leak into the next (story 013).
 */
export function createInitialState(): InitialState {
  return {
    prs: [
      {
        n: 482,
        repo: 'apfm-web',
        title: 'Hero: semantic token refactor',
        state: 'open',
        findings: 2,
        checks: 'passing',
        session: 'hero-refresh',
      },
      {
        n: 219,
        repo: 'referral-api',
        title: 'Partner webhooks + retries',
        state: 'approved',
        findings: 0,
        checks: 'passing',
        session: 'webhooks',
      },
      {
        n: 495,
        repo: 'design-system',
        title: 'Dark-mode token ramp',
        state: 'draft',
        findings: 0,
        checks: 'running',
        session: 'dark-tokens',
      },
      {
        n: 77,
        repo: 'advisor-portal',
        title: 'Tour timezone fix',
        state: 'merged',
        findings: 0,
        checks: 'passing',
        session: 'tz-fix',
      },
    ],
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
