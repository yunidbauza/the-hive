// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_MERGE_AGENT,
  autoMergeRule,
  autoMergeRulesFor,
  createAutoMergeGrants,
} from '../../../../electron/main/agents/auto-merge';
import type { RepoRef } from '../../../../electron/main/integrations/github/query';
import { matches } from '../../../../electron/shared/permission-rules';
import type { ProjectConfig } from '../../../../electron/shared/config-contract';

const project = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  key: over.id.slice(0, 2),
  isRepo: true,
  ...over,
});

const hive: RepoRef = { owner: 'yunidbauza', name: 'the-hive' };

describe('autoMergeRule', () => {
  it('composes the narrowest rule the grammar allows, and the real merge command matches it', () => {
    const rule = autoMergeRule(hive);

    expect(rule).toBe('Bash(gh pr merge * --repo yunidbauza/the-hive *)');
    expect(
      matches(rule!, 'Bash', {
        command:
          'gh pr merge 214 --repo yunidbauza/the-hive --squash --match-head-commit 0211110354',
      }),
    ).toBe(true);
  });

  it('does not match another repository, another verb, or a chained command', () => {
    const rule = autoMergeRule(hive)!;

    expect(matches(rule, 'Bash', { command: 'gh pr merge 1 --repo yunidbauza/other --squash' })).toBe(false);
    expect(matches(rule, 'Bash', { command: 'gh pr close 1 --repo yunidbauza/the-hive' })).toBe(false);
    expect(
      matches(rule, 'Bash', {
        command: 'gh pr merge 1 --repo yunidbauza/the-hive --squash; rm -rf /',
      }),
    ).toBe(false);
  });

  it('refuses a slug that carries anything the glob or the rule list reads', () => {
    expect(autoMergeRule({ owner: 'a*b', name: 'x' })).toBeNull();
    expect(autoMergeRule({ owner: 'a', name: 'x,y' })).toBeNull();
    expect(autoMergeRule({ owner: 'a b', name: 'x' })).toBeNull();
  });
});

describe('autoMergeRulesFor', () => {
  const projects = [
    project({ id: 'the-hive', autoMerge: true }),
    project({ id: 'incorpx', autoMerge: true }),
    project({ id: 'ai-sdk' }),
  ];
  const repoOf = (id: string): RepoRef | undefined =>
    id === 'the-hive' ? hive : id === 'incorpx' ? { owner: 'behiques', name: 'incorpx' } : undefined;

  it('grants only the shipper', () => {
    expect(autoMergeRulesFor('fixer', projects, repoOf)).toEqual([]);
    expect(autoMergeRulesFor('builder', projects, repoOf)).toEqual([]);
    expect(autoMergeRulesFor(AUTO_MERGE_AGENT, projects, repoOf)).toHaveLength(2);
  });

  it('grants nothing for a project without consent, or without a known slug', () => {
    const rules = autoMergeRulesFor(AUTO_MERGE_AGENT, projects, (id) =>
      id === 'the-hive' ? hive : undefined,
    );

    expect(rules).toEqual(['Bash(gh pr merge * --repo yunidbauza/the-hive *)']);
  });
});

describe('createAutoMergeGrants', () => {
  it('answers from the last refresh and schedules one when a flagged project has no slug yet', async () => {
    const resolve = vi.fn(async () => new Map([['the-hive', hive]]));
    const grants = createAutoMergeGrants({
      projects: () => [project({ id: 'the-hive', autoMerge: true })],
      resolve,
    });

    // Nothing known yet: no grant, and a refresh in flight.
    expect(grants.grantsFor(AUTO_MERGE_AGENT)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
    await grants.refresh();

    expect(grants.grantsFor(AUTO_MERGE_AGENT)).toEqual([
      'Bash(gh pr merge * --repo yunidbauza/the-hive *)',
    ]);
    // Known now: no second resolve for the same wake.
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('never refreshes for an agent that cannot receive the grant', () => {
    const resolve = vi.fn(async () => new Map<string, RepoRef>());
    const grants = createAutoMergeGrants({
      projects: () => [project({ id: 'the-hive', autoMerge: true })],
      resolve,
    });

    expect(grants.grantsFor('fixer')).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps a slug it knew through an offline refresh, and drops one for a removed project', async () => {
    let projects = [project({ id: 'the-hive', autoMerge: true }), project({ id: 'gone', autoMerge: true })];
    let answer: () => Promise<Map<string, RepoRef>> = async () =>
      new Map([
        ['the-hive', hive],
        ['gone', { owner: 'x', name: 'gone' }],
      ]);
    const grants = createAutoMergeGrants({ projects: () => projects, resolve: () => answer() });
    await grants.refresh();
    expect(grants.grantsFor(AUTO_MERGE_AGENT)).toHaveLength(2);

    answer = async () => {
      throw new Error('offline');
    };
    await grants.refresh();
    projects = [project({ id: 'the-hive', autoMerge: true })];

    expect(grants.grantsFor(AUTO_MERGE_AGENT)).toEqual([
      'Bash(gh pr merge * --repo yunidbauza/the-hive *)',
    ]);
  });

  it('collapses concurrent refreshes into one resolve', async () => {
    const resolve = vi.fn(async () => new Map<string, RepoRef>());
    const grants = createAutoMergeGrants({ projects: () => [], resolve });

    await Promise.all([grants.refresh(), grants.refresh(), grants.refresh()]);

    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
