// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseAgent } from '../../../electron/main/agents/definition';
import { AGENT_ICON_NAMES } from '@features/settings/components/agent-form';
import { matches } from '../../../electron/shared/permission-rules';
import { createScheduler } from '../../../electron/main/agents/scheduler';
import { createAgentState } from '../../../electron/main/agents/state';
import type { LedgerEntry } from '../../../electron/shared/ledger-contract';

/**
 * Every agent the app ships parses against the skills the app ships
 * (HIVE-168). The seeder copies these into `~/.hive/agents` verbatim, and a
 * definition the registry refuses is listed with its problem and never wakes,
 * which would be a shipped agent that does nothing on a fresh machine.
 */
const resources = fileURLToPath(new URL('../../../resources', import.meta.url));
const shippedSkills = readdirSync(join(resources, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const shippedAgents = readdirSync(join(resources, 'agents'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('shipped agents', () => {
  it('ships shipper, acr, fixer and builder', () => {
    expect(shippedAgents.sort()).toEqual(['acr', 'builder', 'fixer', 'shipper']);
  });

  it.each(shippedAgents)('%s parses against the shipped skills', (name) => {
    const source = readFileSync(join(resources, 'agents', name, 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: name,
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    expect('problems' in result ? result.problems : []).toEqual([]);
    if ('def' in result) {
      expect(result.def.name).toBe(name);
      // An icon the Settings list does not know draws as a question mark.
      expect(AGENT_ICON_NAMES).toContain(result.def.icon);
    }
  });

  it('never grants the shipper a merge, by gh pr merge, by REST or by a GraphQL mutation', () => {
    const source = readFileSync(join(resources, 'agents', 'shipper', 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: 'shipper',
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    if (!('def' in result)) throw new Error('shipper does not parse');
    const allows = (command: string) =>
      result.def.tools.some((rule) => matches(rule, 'Bash', { command }));

    // The real fence, over the real rules: the grammar is what says no.
    expect(allows('gh pr merge 1 --squash --repo o/r')).toBe(false);
    expect(allows('gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash')).toBe(false);
    expect(allows("gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'")).toBe(false);
    // What the stage table does run.
    expect(allows('gh pr view 1 --repo o/r --json state,headRefOid')).toBe(true);
    expect(allows('gh pr checks 1 --repo o/r')).toBe(true);
    expect(allows('git -C /w merge --ff-only origin/feat')).toBe(true);
    expect(allows('gh workflow list --repo o/r --json name,path,state')).toBe(true);
    // The guard merge-pr and sync read before touching a person's checkout.
    expect(allows('git -C /w status --porcelain')).toBe(true);
    expect(allows('git -C /w branch --show-current')).toBe(true);
  });

  it('gives the shipper a gather it can run: the ship skill names no gh api, no jq and no prefetch script', () => {
    const source = readFileSync(join(resources, 'agents', 'shipper', 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: 'shipper',
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    if (!('def' in result)) throw new Error('shipper does not parse');
    const allows = (command: string) =>
      result.def.tools.some((rule) => matches(rule, 'Bash', { command }));
    const ship = readFileSync(join(resources, 'skills', 'ship', 'SKILL.md'), 'utf8');
    const row = (stage: string) => {
      const line = ship.split('\n').find((l) => l.startsWith(`| \`${stage}\` |`));
      if (!line) throw new Error(`ship has no ${stage} row`);
      return line;
    };

    // The gather is the shipper's own: a review body in any state, a PR-level
    // comment and the checks, from the one call it holds.
    expect(allows('gh pr view 1 --repo o/r --json reviews,comments,latestReviews,statusCheckRollup')).toBe(true);
    expect(allows('gh api repos/o/r/pulls/1/reviews')).toBe(false);
    expect(allows('jq .')).toBe(false);
    for (const stage of ['findings', 'approval']) {
      expect(row(stage)).not.toMatch(/gh api|\bjq\b|prefetch-feedback|repos\/<owner>/);
    }
    expect(row('findings')).toContain('--json reviews,comments,latestReviews,statusCheckRollup');
  });
});

/**
 * HIVE-174. A transition writes to the person's Jira, so it is not in the
 * standing grants; the two agents that move tickets name it, and nobody
 * shipped comments.
 */
describe('the Jira writes are consented, not standing', () => {
  const toolsOf = (name: string): readonly string[] => {
    const source = readFileSync(join(resources, 'agents', name, 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: name,
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    if (!('def' in result)) throw new Error(`${name} does not parse`);
    return result.def.tools;
  };

  it('builder and shipper hold jira_transition; acr and fixer do not; nobody holds jira_comment', () => {
    for (const name of ['builder', 'shipper']) {
      expect(toolsOf(name).some((rule) => matches(rule, 'mcp__hive__jira_transition', {}))).toBe(true);
    }
    for (const name of ['acr', 'fixer']) {
      expect(toolsOf(name).some((rule) => matches(rule, 'mcp__hive__jira_transition', {}))).toBe(false);
    }
    for (const name of ['builder', 'shipper', 'acr', 'fixer']) {
      expect(toolsOf(name).some((rule) => matches(rule, 'mcp__hive__jira_comment', {}))).toBe(false);
    }
  });

  it.each([
    ['shipper', 'repo', 3],
    ['builder', 'thread', 2],
    ['fixer', 'thread', 2],
    ['acr', 'thread', 3],
  ] as const)('%s lanes by %s with parallel %i (HIVE-189)', (name, lane, parallel) => {
    const source = readFileSync(join(resources, 'agents', name, 'AGENT.md'), 'utf8');
    const result = parseAgent(source, { folder: name, skillNames: shippedSkills, hiveSkillNames: shippedSkills, integrations: ['slack'] });
    if (!('def' in result)) throw new Error(`${name} does not parse`);
    expect(result.def.lane).toBe(lane);
    expect(result.def.limits.parallel).toBe(parallel);
  });

  it('gives the shipper a day that fits a real shipping day, and a per-run cap its lanes reserve (HIVE-189)', () => {
    const source = readFileSync(join(resources, 'agents', 'shipper', 'AGENT.md'), 'utf8');
    const result = parseAgent(source, { folder: 'shipper', skillNames: shippedSkills, hiveSkillNames: shippedSkills, integrations: ['slack'] });
    if (!('def' in result)) throw new Error('shipper does not parse');
    expect(result.def.limits).toMatchObject({ dailyUsd: 40, budgetUsd: 2, parallel: 3 });
  });
});

describe('the shipped agents in lanes, through the scheduler (HIVE-189)', () => {
  const parsed = (name: string) => {
    const source = readFileSync(join(resources, 'agents', name, 'AGENT.md'), 'utf8');
    const result = parseAgent(source, { folder: name, skillNames: shippedSkills, hiveSkillNames: shippedSkills, integrations: ['slack'] });
    if (!('def' in result)) throw new Error(`${name} does not parse`);
    return result.def;
  };

  const harness = (name: string) => {
    const def = parsed(name);
    const entries: LedgerEntry[] = [];
    const live = new Set<string>();
    const started: string[] = [];
    const state = createAgentState({ path: '/dev/null/agents.json', debounceMs: 1 });
    state.patch(name, { status: 'sleeping' });
    const scheduler = createScheduler({
      run: (_n, _t, _e, options) => {
        const lane = options?.lane ?? 'standing';
        if (live.has(lane)) return { started: false, refused: 'working' };
        if (live.size >= def.limits.parallel) return { started: false, refused: 'saturated' };
        live.add(lane);
        started.push(lane);
        return { started: true, run: `run-${String(started.length)}`, kind: 'standing' };
      },
      state,
      isAgent: (id) => id === name,
      wakesOnLedger: () => true,
      parallelFor: () => def.limits.parallel,
      schedules: () => new Map(),
      pushStatus: () => undefined,
      ledger: { read: () => ({ entries }), append: () => ({ ok: true }) },
      now: () => 0,
      laneOf: () => def.lane,
      laneLive: (_n, lane) => live.has(lane),
    });
    const ask = (id: string, meta: Record<string, unknown> = {}) => {
      const entry: LedgerEntry = { id, ts: 0, from: 'sess-1', to: name, kind: 'ask', body: 'job', meta };
      entries.push(entry);
      scheduler.onEntry(entry);
    };
    return { ask, started, state };
  };

  it('ships two repositories at once and queues a second PR on the same one', () => {
    const { ask, started, state } = harness('shipper');
    ask('s1', { pr: 1, repo: 'a/x' });
    ask('s2', { pr: 2, repo: 'b/y' });
    ask('s3', { pr: 3, repo: 'a/x' });

    expect(started).toEqual(['repo:a/x', 'repo:b/y']);
    expect(state.lane('shipper', 'repo:a/x').pendingWake).toEqual([
      expect.objectContaining({ kind: 'ask', id: 's3' }),
    ]);
    state.dispose();
  });

  it('builds two plans at once', () => {
    const { ask, started, state } = harness('builder');
    ask('b1', { repo: 'a/x' });
    ask('b2', { repo: 'a/x' });

    expect(started).toEqual(['thread:b1', 'thread:b2']);
    state.dispose();
  });
});

/**
 * The shipper's merge gate reads the live thread count and the `findings`
 * claim; an old fixer `clean` is history, and a bodyless review is a finding
 * only when it can hold inline comments nobody answered.
 */
describe('the shipper merge gate', () => {
  const read = (...path: string[]): string => readFileSync(join(resources, ...path), 'utf8');
  const shipRow = (stage: string): string => {
    const line = read('skills', 'ship', 'SKILL.md')
      .split('\n')
      .find((l) => l.startsWith(`| \`${stage}\` |`));
    if (!line) throw new Error(`ship has no ${stage} row`);
    return line;
  };

  it("the shipper's own merge section no longer names the fixer's clean as the thread check", () => {
    const merge = read('agents', 'shipper', 'AGENT.md').split('## The merge')[1] ?? '';
    expect(merge).not.toMatch(/unresolved-thread\s+check\s+is\s+the\s+fixer's\s+last\s+`clean`/);
    expect(merge).toMatch(/`findings`/);
    expect(merge).toMatch(/`clean`[^.]*history/);
  });

  it('findings hands over a bodyless review only when it can hold inline comments', () => {
    const row = shipRow('findings');
    expect(row).toMatch(/bodyless `APPROVED`[^.]*(left out|carries nothing)/);
    expect(row).toMatch(/author[^.]*posted a `<!-- hive-fixer` comment/);
  });

  it('merge-pr says the thread count can be ninety seconds old and what a HOLD on it does', () => {
    expect(read('skills', 'merge-pr', 'SKILL.md')).toMatch(/ninety\s+seconds/);
  });
});
