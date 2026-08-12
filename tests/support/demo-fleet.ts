import type { Agent, Entity, Project, Session } from '@/types/entity';
import type { TermColor, TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';
import { emptySnapshot } from '@shared/config-contract';
import type { PrRecord } from '@shared/github-contract';

import { setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';

/**
 * A sample fleet, for tests that need one.
 *
 * ## Why this is in `tests/` and not `src/data/`
 *
 * This dataset — ten sessions, three agents, five projects, eight tickets and
 * an orchestrator banner — used to ship inside the app as `createInitialState()`
 * and was loaded into the store at boot. That was the bug: the header counted a
 * fleet that was not running, the projects tree listed repositories nobody had
 * mapped, and the WORK tab painted eight sample tickets for a frame before the
 * real Jira read replaced them.
 *
 * The data itself was never the problem — it is well-tuned, ported from the
 * concept file (retired from the tree), and its status mix and half-finished
 * transcripts are exactly what a panel test wants to assert against. So it moved
 * here rather than being deleted. **The product boots empty; the tests seed
 * themselves.**
 *
 * That inversion is worth the file. A test that calls {@link seedDemoFleet}
 * states its own preconditions, which the old arrangement hid: every panel test
 * silently depended on a module it never imported, and "does this panel render
 * an empty list correctly" was unaskable because the list was never empty.
 *
 * ## Using it
 *
 * ```ts
 * beforeEach(() => {
 *   useHiveStore.getState().reset();
 *   seedDemoFleet();
 * });
 * ```
 *
 * Tests that exercise empty states, or that build their own entities, simply do
 * not call it.
 */

/** Terminal line shorthand, mirroring the concept's `L(t, c)` helper. */
const line = (text: string, color: TermColor = 'ink'): TermLine => ({
  text,
  color,
});

/**
 * Which ticket each demo session is working (HIVE-73).
 *
 * This is the same data the tickets used to carry as a `sessions` array, turned
 * around to match where the link now lives — on `Session.ticket`, because a
 * ticket is replaced wholesale by every Jira refresh and a session is not.
 *
 * Kept as a map beside the sessions rather than a ninth positional argument to
 * the `session()` helper: eight untyped positions is already the most a reader
 * can hold, and the ticket is the one field here that describes a relationship
 * rather than the session itself.
 *
 * `rails-upgrade` is deliberately absent — the fleet has a session on no ticket
 * at all, which is what makes "does an unlinked session stay off every card"
 * an answerable question.
 */
const SESSION_TICKET: Readonly<Record<string, string>> = {
  'hero-refresh': 'GRAC-3018',
  'lead-form': 'GRAC-3022',
  webhooks: 'GRAC-2991',
  nplusone: 'GRAC-3010',
  'e2e-quote': 'GRAC-3010',
  'call-notes': 'GRAC-2977',
  'dark-tokens': 'GRAC-3005',
  'tz-fix': 'GRAC-2810',
  'ecs-scaling': 'GRAC-2954',
};

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
    // Spread conditionally so an unlinked session has no `ticket` key at all,
    // matching what `spawnSession` produces for one started from the header.
    ...(SESSION_TICKET[id] === undefined ? {} : { ticket: SESSION_TICKET[id] }),
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

/**
 * The slices this fleet supplies.
 *
 * `prs` joined them when GitHub became the producer: the app no longer seeds a
 * PR list, so a test that needs one has to say so. They are declared here rather
 * than in each test because their **branches are the link** — `feat/hero-refresh`
 * is what ties PR #482 to the `hero-refresh` session and, through it, to ticket
 * GRAC-3018. A test writing its own would have to re-derive that mapping to
 * assert anything at all.
 *
 * `notifs` is still absent, because the app does still seed that from
 * `src/data/fixtures.ts` — duplicating it here would give a test two sources for
 * one list and no way to tell which it was asserting against. (`feed` used to
 * be named here too; it is gone with the Activity panel.)
 */
export interface DemoFleet {
  entities: Record<string, Entity>;
  order: string[];
  agentOrder: string[];
  projects: Project[];
  tickets: Ticket[];
  prs: PrRecord[];
  orchLines: TermLine[];
}

/**
 * A factory rather than a frozen object: every test starts from a clean copy,
 * so mutating one test's state cannot leak into the next (story 013).
 */
export function createDemoFleet(): DemoFleet {
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
        statusCategory: 'in-progress',
        title: 'Hero refresh: migrate to semantic tokens',
      },
      {
        key: 'GRAC-3022',
        status: 'In Progress',
        statusCategory: 'in-progress',
        title: 'Lead form: phone/zip validation + index',
      },
      {
        key: 'GRAC-2991',
        status: 'In Review',
        statusCategory: 'in-progress',
        title: 'Partner webhook delivery with retries',
      },
      {
        key: 'GRAC-3010',
        status: 'In Progress',
        statusCategory: 'in-progress',
        title: 'Lead search performance across services',
      },
      {
        key: 'GRAC-2977',
        status: 'In Progress',
        statusCategory: 'in-progress',
        title: 'Advisor call notes editor (PHI-safe)',
      },
      {
        key: 'GRAC-3005',
        status: 'In Review',
        statusCategory: 'in-progress',
        title: 'Dark-mode token ramp for design system',
      },
      {
        key: 'GRAC-2810',
        status: 'Done',
        statusCategory: 'done',
        title: 'Tour times shown in wrong timezone',
      },
      {
        key: 'GRAC-2954',
        status: 'Done',
        statusCategory: 'done',
        title: 'ECS autoscaling policies',
      },
    ],
    /*
      The four PRs the panels assert against, each on a branch one of the
      sessions above is working. They were `src/data/fixtures.ts`'s `prs` array
      until GitHub started feeding that slice for real; the shape changed with
      them — `number` rather than `n`, plus the `branch` and `url` the live
      records carry.
    */
    prs: [
      {
        number: 482,
        title: 'Hero: semantic token refactor',
        url: 'https://github.com/demo/apfm-web/pull/482',
        repo: 'apfm-web',
        owner: 'demo',
        branch: 'feat/hero-refresh',
        state: 'open',
        findings: 2,
        checks: 'passing',
        updatedAt: '2026-08-09T14:37:00Z',
      },
      {
        number: 219,
        title: 'Partner webhooks + retries',
        url: 'https://github.com/demo/referral-api/pull/219',
        repo: 'referral-api',
        owner: 'demo',
        branch: 'feat/partner-webhooks',
        state: 'approved',
        findings: 0,
        checks: 'passing',
        updatedAt: '2026-08-09T14:20:00Z',
      },
      {
        number: 495,
        title: 'Dark-mode token ramp',
        url: 'https://github.com/demo/design-system/pull/495',
        repo: 'design-system',
        owner: 'demo',
        branch: 'feat/dark-tokens',
        state: 'draft',
        findings: 0,
        checks: 'running',
        updatedAt: '2026-08-09T13:58:00Z',
      },
      {
        number: 31,
        title: 'ECS autoscaling policies',
        url: 'https://github.com/demo/infra-terraform/pull/31',
        repo: 'infra-terraform',
        owner: 'demo',
        branch: 'chore/ecs-autoscaling',
        state: 'merged',
        findings: 0,
        checks: 'passing',
        updatedAt: '2026-08-09T09:14:00Z',
      },
      {
        number: 77,
        title: 'Tour timezone fix',
        url: 'https://github.com/demo/advisor-portal/pull/77',
        repo: 'advisor-portal',
        owner: 'demo',
        branch: 'fix/timezone-bug',
        state: 'merged',
        findings: 0,
        checks: 'passing',
        updatedAt: '2026-08-09T11:02:00Z',
      },
    ],
    orchLines: [
      line('maestro v0.4.2 — orchestrator console · host devbox-01', 'dim'),
      line('✓ connected — 10 sessions · 3 agents · single machine', 'green'),
      line('watching ~/.claude/jobs — type `help` for commands', 'dim'),
    ],
  };
}

/**
 * Put the sample fleet into the store.
 *
 * Call it *after* `reset()`, not instead of it: `reset()` also clears the spawn
 * counter and the fake clock, which this does not touch.
 *
 * `setState` merges by default, so the one slice the app still seeds
 * (`notifs`) survives untouched.
 *
 * `ticketSource` and `prSource` are set to `live` because that is what a store
 * holding real tickets and real PRs *means* now. Left at their boot value of
 * `loading`, every panel test would render a skeleton and assert against rows
 * that are deliberately not on screen yet.
 */
export function seedDemoFleet(): DemoFleet {
  const fleet = createDemoFleet();
  /**
   * `projects` is destructured out rather than spread in: the store has no such
   * slice any more. The fleet still carries the list because
   * {@link seedDemoProjectConfig} declares those same projects in the *config*,
   * which is the only thing `useProjects()` reads.
   */
  const { projects: _projects, ...storeSlices } = fleet;
  useHiveStore.setState({
    ...storeSlices,
    ticketSource: { kind: 'live', stale: false, capped: false },
    prSource: { kind: 'live', stale: false, repos: 5 },
  });
  return fleet;
}

/**
 * Declare the demo fleet's five projects in the *config*, which is now the only
 * thing `useProjects()` reads.
 *
 * Separate from {@link seedDemoFleet} on purpose. The store's `projects` slice
 * and the config snapshot answer two different questions — "which projects do
 * these sessions name?" and "which projects has the user mapped?" — and the
 * merge that used to blur them is gone. Tests of the settings screen drive the
 * config themselves and must not have one imposed on them, so a test that wants
 * the rail populated asks for both:
 *
 * ```ts
 * seedDemoFleet();
 * seedDemoProjectConfig();
 * ```
 */
export function seedDemoProjectConfig(): void {
  setProjectConfigForTest({
    ...emptySnapshot('/tmp/hive/config.json'),
    projects: createDemoFleet().projects.map((project) => ({
      id: project.id,
      name: project.id,
      path: `/repos/${project.id}`,
      icon: project.icon,
      origin: 'local',
      status: 'ok',
      isRepo: true,
    })),
  });
}
