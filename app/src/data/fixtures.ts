import type { Agent, Entity, Project, Session } from '@/types/entity';
import type { FeedItem } from '@/types/feed';
import type { Notification } from '@/types/notification';
import type { Pr } from '@/types/pull-request';
import type { TermColor, TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';

/**
 * The demo dataset, ported verbatim from `concept/Command Center.dc.html`.
 *
 * It is well-tuned: the status mix, the half-finished transcripts, and the two
 * blocked sessions are what make the command center read as a live system
 * rather than a screenshot. Change values here only alongside the concept.
 *
 * Nothing outside `src/stores/` may import this module — enforced by an import
 * zone (story 014), not by review. Panels read derived state through selector
 * hooks so there is exactly one source of truth for every number on screen.
 */

/** Terminal line shorthand, mirroring the concept's `L(t, c)` helper. */
const line = (text: string, color: TermColor = 'ink'): TermLine => ({
  text,
  color,
});

function createSessions(): Session[] {
  const session = (
    id: string,
    project: string,
    branch: string,
    status: Session['status'],
    task: string,
    pr: Session['pr'],
    cost: string,
    lines: TermLine[],
  ): Session => ({
    kind: 'session',
    id,
    project,
    branch,
    status,
    task,
    pr,
    cost,
    lines,
  });

  return [
    session(
      'hero-refresh',
      'apfm-web',
      'feat/hero-refresh',
      'working',
      'Refactor hero to semantic tokens',
      { n: 482, state: 'open' },
      '$2.41',
      [
        line('❯ claude --resume feat/hero-refresh', 'green'),
        line('● Read src/components/Hero.tsx', 'blue'),
        line('● Edit src/components/Hero.tsx  (+38 −21)', 'blue'),
        line('  swapped hardcoded hex for --surface-brand tokens', 'dim'),
        line('● Bash  yarn test Hero', 'blue'),
        line('  ✓ 12 passed, 0 failed  (3.2s)', 'green'),
        line('● Edit src/styles/hero.css  (+14 −9)', 'blue'),
        line('✱ Working… refactoring responsive breakpoints', 'amber'),
      ],
    ),
    session(
      'lead-form',
      'apfm-web',
      'fix/lead-form-validation',
      'waiting',
      'Fix lead form validation',
      null,
      '$0.87',
      [
        line('❯ claude --resume fix/lead-form-validation', 'green'),
        line('● Read src/forms/LeadForm.tsx', 'blue'),
        line('● Edit src/forms/schema.ts  (+19 −6)', 'blue'),
        line('  added phone + zip validation, E.164 normalization', 'dim'),
        line(''),
        line(
          '? Permission needed: yarn prisma migrate dev --name lead_phone_idx',
          'amber',
        ),
        line('  session paused — approve with:  send lead-form y', 'dim'),
      ],
    ),
    session(
      'webhooks',
      'referral-api',
      'feat/partner-webhooks',
      'working',
      'Partner webhook delivery + retries',
      { n: 219, state: 'open' },
      '$3.12',
      [
        line('❯ claude --resume feat/partner-webhooks', 'green'),
        line('● Edit app/services/webhook_dispatcher.rb  (+64 −12)', 'blue'),
        line('  exponential backoff, DLQ after 5 attempts', 'dim'),
        line('● Bash  bundle exec rspec spec/services', 'blue'),
        line('  ✓ 42 examples, 0 failures  (11.4s)', 'green'),
        line('● gh pr create → #219 opened', 'cyan'),
        line('✱ Working… adding signature verification docs', 'amber'),
      ],
    ),
    session(
      'rails-upgrade',
      'referral-api',
      'chore/rails-7.2',
      'idle',
      'Rails 7.2 upgrade spike',
      null,
      '$1.05',
      [
        line('❯ claude --resume chore/rails-7.2', 'green'),
        line('● Bash  bundle update rails --conservative', 'blue'),
        line('  47 gems updated, 3 deprecation warnings logged', 'dim'),
        line(''),
        line('✓ session idle — context saved, resume any time', 'dim'),
      ],
    ),
    session(
      'call-notes',
      'advisor-portal',
      'feat/call-notes',
      'waiting',
      'Advisor call notes editor',
      null,
      '$1.66',
      [
        line('❯ claude --resume feat/call-notes', 'green'),
        line('● Edit src/features/calls/NotesPanel.tsx  (+88 −0)', 'blue'),
        line('● Read docs/compliance/phi-handling.md', 'blue'),
        line(''),
        line('? Question: should call notes be immutable after save', 'amber'),
        line('  (append-only audit trail), or editable for 24h?', 'amber'),
        line('  reply with:  send call-notes <answer>', 'dim'),
      ],
    ),
    session(
      'tz-fix',
      'advisor-portal',
      'fix/timezone-bug',
      'done',
      'Tour times shown in wrong timezone',
      { n: 77, state: 'merged' },
      '$0.54',
      [
        line('❯ claude --resume fix/timezone-bug', 'green'),
        line('● Edit src/lib/dates.ts  (+7 −3)', 'blue'),
        line('  store UTC, render in community local tz', 'dim'),
        line('● Bash  yarn test dates  →  ✓ 9 passed', 'green'),
        line('✓ PR #77 merged — session complete', 'green'),
      ],
    ),
    session(
      'dark-tokens',
      'design-system',
      'feat/dark-tokens',
      'working',
      'Dark-mode token ramp',
      null,
      '$2.08',
      [
        line('❯ claude --resume feat/dark-tokens', 'green'),
        line('● Read tokens/colors.css', 'blue'),
        line('● Edit tokens/dark.css  (+112 −0)', 'blue'),
        line(
          '  derived dark surfaces from Nile blue, kept warm neutrals',
          'dim',
        ),
        line('✱ Working… contrast-checking text roles (AA large)', 'amber'),
      ],
    ),
    session(
      'ecs-scaling',
      'infra-terraform',
      'chore/ecs-autoscaling',
      'done',
      'ECS autoscaling policies',
      { n: 31, state: 'merged' },
      '$0.92',
      [
        line('❯ claude --resume chore/ecs-autoscaling', 'green'),
        line('● Edit modules/ecs/autoscaling.tf  (+41 −8)', 'blue'),
        line('● Bash  terraform plan  →  4 to add, 0 to destroy', 'cyan'),
        line(
          '✓ PR #31 merged, applied in staging — session complete',
          'green',
        ),
      ],
    ),
    session(
      'e2e-quote',
      'apfm-web',
      'test/e2e-quote-flow',
      'idle',
      'E2E coverage for quote flow',
      null,
      '$0.31',
      [
        line('❯ claude --resume test/e2e-quote-flow', 'green'),
        line('● Write e2e/quote-flow.spec.ts  (+134)', 'blue'),
        line('  4 scenarios drafted, fixtures pending', 'dim'),
        line('✓ session idle — waiting for fixture data', 'dim'),
      ],
    ),
    session(
      'nplusone',
      'referral-api',
      'fix/n-plus-one',
      'working',
      'Kill N+1 queries in lead search',
      null,
      '$1.19',
      [
        line('❯ claude --resume fix/n-plus-one', 'green'),
        line('● Bash  bundle exec derailed exec perf:objects', 'blue'),
        line(
          '  Lead.search: 214 queries → includes(:community, :advisor)',
          'dim',
        ),
        line('● Edit app/models/lead.rb  (+9 −2)', 'blue'),
        line('✱ Working… verifying with query counter specs', 'amber'),
      ],
    ),
  ];
}

function createAgents(): Agent[] {
  const agent = (
    id: string,
    icon: string,
    sub: string,
    task: string,
    lines: TermLine[],
  ): Agent => ({ kind: 'agent', id, icon, sub, task, status: 'online', lines });

  return [
    agent(
      'slack-agent',
      'ph-slack-logo',
      '#eng-alerts · #deploys · #ask-eng',
      'Posts digests, answers @dev-team mentions',
      [
        line('❯ agent slack-agent — monitoring 3 channels', 'green'),
        line('● 09:05  posted standup digest to #eng-alerts', 'blue'),
        line(
          '● 11:32  answered @dev-team in #ask-eng (webhook docs)',
          'blue',
        ),
        line('● 14:05  posted deploy digest — advisor-portal v2.31', 'blue'),
        line('✱ Listening…', 'amber'),
      ],
    ),
    agent(
      'pr-reviewer',
      'ph-git-pull-request',
      'Auto-reviews open PRs',
      'First-pass review on every open PR',
      [
        line('❯ agent pr-reviewer — watching 4 open PRs', 'green'),
        line('● Reviewed #482 hero-refresh — 2 suggestions left', 'blue'),
        line('● Reviewed #219 webhooks — approved ✓', 'green'),
        line('✱ Listening for new commits…', 'amber'),
      ],
    ),
    agent(
      'standup-agent',
      'ph-calendar-check',
      'Daily summary at 9:05',
      'Compiles yesterday’s session activity into standup notes',
      [
        line('❯ agent standup-agent — next run 09:05 tomorrow', 'green'),
        line('● Drafted summary: 6 sessions, 3 PRs, 2 merged', 'blue'),
        line('✓ idle until scheduled run', 'dim'),
      ],
    ),
  ];
}

/** Domain state as it exists before the user touches anything. */
export interface InitialState {
  entities: Record<string, Entity>;
  order: string[];
  agentOrder: string[];
  projects: Project[];
  tickets: Ticket[];
  prs: Pr[];
  notifs: Notification[];
  feed: FeedItem[];
  orchLines: TermLine[];
}

/**
 * A factory rather than a frozen object: every test starts from a clean copy,
 * so mutating one test's state cannot leak into the next (story 013).
 */
export function createInitialState(): InitialState {
  const entities: Record<string, Entity> = {};
  for (const entity of [...createSessions(), ...createAgents()]) {
    entities[entity.id] = entity;
  }

  return {
    entities,
    order: [
      'hero-refresh',
      'lead-form',
      'webhooks',
      'rails-upgrade',
      'call-notes',
      'tz-fix',
      'dark-tokens',
      'ecs-scaling',
      'e2e-quote',
      'nplusone',
    ],
    agentOrder: ['slack-agent', 'pr-reviewer', 'standup-agent'],
    projects: [
      { id: 'apfm-web', icon: 'ph-globe-hemisphere-west' },
      { id: 'referral-api', icon: 'ph-cube' },
      { id: 'advisor-portal', icon: 'ph-users-three' },
      { id: 'design-system', icon: 'ph-swatches' },
      { id: 'infra-terraform', icon: 'ph-stack' },
    ],
    tickets: [
      {
        key: 'GRAC-3018',
        status: 'In Progress',
        title: 'Hero refresh: migrate to semantic tokens',
        sessions: ['hero-refresh'],
      },
      {
        key: 'GRAC-3022',
        status: 'In Progress',
        title: 'Lead form: phone/zip validation + index',
        sessions: ['lead-form'],
      },
      {
        key: 'GRAC-2991',
        status: 'In Review',
        title: 'Partner webhook delivery with retries',
        sessions: ['webhooks'],
      },
      {
        key: 'GRAC-3010',
        status: 'In Progress',
        title: 'Lead search performance across services',
        sessions: ['nplusone', 'e2e-quote'],
      },
      {
        key: 'GRAC-2977',
        status: 'In Progress',
        title: 'Advisor call notes editor (PHI-safe)',
        sessions: ['call-notes'],
      },
      {
        key: 'GRAC-3005',
        status: 'In Review',
        title: 'Dark-mode token ramp for design system',
        sessions: ['dark-tokens'],
      },
      {
        key: 'GRAC-2810',
        status: 'Done',
        title: 'Tour times shown in wrong timezone',
        sessions: ['tz-fix'],
      },
      {
        key: 'GRAC-2954',
        status: 'Done',
        title: 'ECS autoscaling policies',
        sessions: ['ecs-scaling'],
      },
    ],
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
    feed: [
      {
        time: '14:37',
        txt: 'Loop: polled 4 open PRs — no new feedback',
        tone: 'brand',
        icon: 'ph-arrows-clockwise',
      },
      {
        time: '14:36',
        txt: 'Routed your reply to call-notes',
        tone: 'brand',
        icon: 'ph-paper-plane-tilt',
      },
      {
        time: '14:34',
        txt: 'Slack: comment on PR #219 in #eng-alerts — response drafted and posted',
        tone: 'brand',
        icon: 'ph-slack-logo',
      },
      {
        time: '14:32',
        txt: 'pr-reviewer kicked off automatically on #482 (new push)',
        tone: 'green',
        icon: 'ph-robot',
      },
      {
        time: '14:28',
        txt: 'Applied review fixes on #219 — 2 findings resolved',
        tone: 'green',
        icon: 'ph-git-pull-request',
      },
      {
        time: '14:21',
        txt: 'Spawned nplusone on referral-api',
        tone: 'brand',
        icon: 'ph-plus-circle',
      },
      {
        time: '14:12',
        txt: 'lead-form paused — permission needed',
        tone: 'amber',
        icon: 'ph-hand-palm',
      },
    ],
    orchLines: [
      line('maestro v0.4.2 — orchestrator console · host devbox-01', 'dim'),
      line('✓ connected — 10 sessions · 3 agents · single machine', 'green'),
      line('watching ~/.claude/jobs — type `help` for commands', 'dim'),
    ],
  };
}
