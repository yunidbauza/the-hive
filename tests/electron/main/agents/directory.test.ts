// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRunState,
  AgentsSnapshot,
  AgentSummary,
} from '../../../../electron/shared/agent-contract';
import {
  CONFIG_PATH_ENV,
  ProjectAutoMergeRefused,
  type ConfigSnapshot,
} from '../../../../electron/shared/config-contract';
import {
  agentsDirectoryFor,
  projectAutoMergeFor,
  projectsDirectoryFor,
} from '../../../../electron/main/agents/directory';

/**
 * The directory a peer sees (HIVE-127).
 *
 * Everything worth getting wrong here is a data decision — who is excluded,
 * which status is reported, and above all which fields cross the process
 * boundary into a model's context — so all of it is asserted here, where no
 * socket and no child process is involved.
 */

const agent = (over: Partial<AgentSummary> & { name: string }): AgentSummary => ({
  description: '',
  icon: 'ph-robot',
  status: 'sleeping',
  wake: { on: [] },
  mcp: [],
  tools: [],
  runs: [],
  rotateAfter: 20,
  ...over,
});

const snapshotOf = (...agents: AgentSummary[]): AgentsSnapshot => ({
  agents,
  agentsRoot: '/home/someone/.hive/agents',
});

const runState = (over: Partial<AgentRunState> = {}): AgentRunState => ({
  status: 'sleeping',
  runsSinceRotate: 0,
  runs: [],
  ...over,
});

describe('agentsDirectoryFor', () => {
  it('returns each peer with the fields a caller can act on', () => {
    const snapshot = snapshotOf(
      agent({
        name: 'pr-reviewer',
        description: 'Reviews open PRs for correctness and style.',
        wake: { on: ['ledger'] },
        tools: ['Bash(gh *)', 'Read'],
      }),
    );

    expect(agentsDirectoryFor('scout', snapshot, {}).agents).toEqual([
      {
        name: 'pr-reviewer',
        description: 'Reviews open PRs for correctness and style.',
        status: 'sleeping',
        accepts: ['ledger'],
        tools: ['Bash(gh *)', 'Read'],
      },
    ]);
  });

  it('excludes the caller, so an agent never finds itself', () => {
    const snapshot = snapshotOf(agent({ name: 'scout' }), agent({ name: 'pr-reviewer' }));

    expect(agentsDirectoryFor('scout', snapshot, {}).agents.map((a) => a.name)).toEqual([
      'pr-reviewer',
    ]);
  });

  /*
    An answer, not a failure. "There is nobody else here" is something a model
    can act on — do the work itself, or report that there is nobody to delegate
    to — and conflating it with an error would make both unreadable.
  */
  it('is empty, not an error, when the caller is the only agent', () => {
    expect(agentsDirectoryFor('scout', snapshotOf(agent({ name: 'scout' })), {})).toEqual({
      agents: [],
    });
  });

  it('sorts by name, so the output is stable for the model and the tests', () => {
    const snapshot = snapshotOf(
      agent({ name: 'zergling' }),
      agent({ name: 'drone' }),
      agent({ name: 'mutalisk' }),
    );

    expect(agentsDirectoryFor('overmind', snapshot, {}).agents.map((a) => a.name)).toEqual([
      'drone',
      'mutalisk',
      'zergling',
    ]);
  });

  /*
    `registry.list()` hard-codes `sleeping` because it has no way to tell —
    only `agents.json` has ever seen a process. A directory that skipped the
    join would confidently report every peer as asleep, which is worse than
    reporting nothing: a caller would queue behind an agent it believes idle.
  */
  it('reports the live status, not the registry placeholder', () => {
    const [peer] = agentsDirectoryFor('scout', snapshotOf(agent({ name: 'pr-reviewer' })), {
      'pr-reviewer': runState({ status: 'working' }),
    }).agents;

    expect(peer?.status).toBe('working');
  });

  it('lists a broken definition with its problem rather than hiding it', () => {
    const snapshot = snapshotOf(agent({ name: 'scout', invalid: "wake.on: unknown event 'ledgr'" }));

    expect(agentsDirectoryFor('pr-reviewer', snapshot, {}).agents[0]).toEqual({
      name: 'scout',
      description: '',
      status: 'sleeping',
      accepts: [],
      tools: [],
      invalid: "wake.on: unknown event 'ledgr'",
    });
  });

  it('omits invalid entirely when the definition parsed', () => {
    const snapshot = snapshotOf(agent({ name: 'pr-reviewer' }));

    expect(agentsDirectoryFor('scout', snapshot, {}).agents[0]).not.toHaveProperty('invalid');
  });

  /**
   * The guard that matters.
   *
   * `AgentSummary` carries a live conversation id and a spend figure. This
   * asserts the projection is a whitelist, so a field added to that type later
   * cannot silently ride along into a peer's context.
   */
  it('never leaks a field a peer has no business seeing', () => {
    const snapshot = snapshotOf(
      agent({
        name: 'pr-reviewer',
        sessionUuid: '11111111-2222-3333-4444-555555555555',
        cost: '$1.23',
        dailyUsd: 4.5,
        today: { day: '2026-09-01', runs: 9, usd: 4.5 },
        lastRunAt: 1_756_000_000_000,
      }),
    );

    const [peer] = agentsDirectoryFor('scout', snapshot, {}).agents;

    expect(Object.keys(peer ?? {}).sort()).toEqual([
      'accepts',
      'description',
      'name',
      'status',
      'tools',
    ]);
    expect(JSON.stringify(peer)).not.toContain('11111111');
    expect(JSON.stringify(peer)).not.toContain('.hive/agents');
  });

  it('copies the lists rather than aliasing the snapshot', () => {
    const source = agent({ name: 'pr-reviewer', wake: { on: ['ledger'] }, tools: ['Read'] });

    const [peer] = agentsDirectoryFor('scout', snapshotOf(source), {}).agents;

    expect(peer?.accepts).not.toBe(source.wake.on);
    expect(peer?.tools).not.toBe(source.tools);
  });
});

describe('projectsDirectoryFor (HIVE-173)', () => {
  const project = {
    id: 'the-hive',
    key: 'hive',
    name: 'The Hive',
    path: '/repos/the-hive',
    icon: 'ph-folder',
    origin: 'local' as const,
    status: 'ok' as const,
    isRepo: true,
  };
  const snapshot = (projects: ConfigSnapshot['projects']): ConfigSnapshot =>
    ({ projects }) as unknown as ConfigSnapshot;

  it('projects each project to what an agent may see, and nothing of the machine', () => {
    const directory = projectsDirectoryFor(
      snapshot([
        { ...project, autoMerge: true, env: { SECRET: 'x' }, shell: '/bin/zsh', claudeCommand: 'claude' },
        {
          ...project,
          id: 'boxed',
          key: 'bx',
          container: { workspace: '/workspace', hiveDir: '/hive' } as never,
        },
        { ...project, id: 'gone', key: 'g', path: null, status: 'missing' },
      ]),
    );

    expect(directory).toEqual({
      projects: [
        {
          id: 'the-hive',
          key: 'hive',
          name: 'The Hive',
          path: '/repos/the-hive',
          status: 'ok',
          origin: 'local',
          autoMerge: true,
        },
        expect.objectContaining({ id: 'boxed', autoMerge: false, container: { workspace: '/workspace' } }),
        expect.objectContaining({ id: 'gone', path: null, status: 'missing', autoMerge: false }),
      ],
    });
    for (const entry of directory.projects) {
      expect(Object.keys(entry)).not.toContain('env');
      expect(Object.keys(entry)).not.toContain('shell');
      expect(Object.keys(entry)).not.toContain('claudeCommand');
      expect(Object.keys(entry)).not.toContain('icon');
    }
  });

  it('answers an empty list for an empty config', () => {
    expect(projectsDirectoryFor(snapshot([]))).toEqual({ projects: [] });
  });
});

/*
  Retro B, Task 3: the handler `project_auto_merge` reaches, composed the way
  `ipc/index.ts` composes it, against a real config file in a temp directory.
  `projectsDirectoryFor(getConfig())` is the `projects` handler verbatim.
*/
describe('projectAutoMergeFor (retro B)', () => {
  let sandbox: string;
  let path: string;
  const originalConfigPath = process.env[CONFIG_PATH_ENV];
  const originalHome = process.env.HOME;

  const load = async () => {
    vi.resetModules();
    const config = await import('../../../../electron/main/config/index');
    return {
      config,
      deps: { config: config.getConfig, setAutoMerge: config.setProjectAutoMerge },
    };
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'hive-auto-merge-'));
    const home = join(sandbox, 'home');
    mkdirSync(home);
    mkdirSync(join(sandbox, 'the-hive'));
    mkdirSync(join(sandbox, 'other'));
    path = join(sandbox, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        projects: [
          { id: 'the-hive', name: 'The Hive', path: join(sandbox, 'the-hive'), key: 'hive' },
          { id: 'other', name: 'Other', path: join(sandbox, 'other'), key: 'ot' },
        ],
      }),
    );
    process.env.HOME = home;
    process.env[CONFIG_PATH_ENV] = path;
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sandbox, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = originalConfigPath;
  });

  const onDisk = (id: string): unknown =>
    (JSON.parse(readFileSync(path, 'utf8')) as { projects: { id: string; autoMerge?: unknown }[] }).projects.find(
      (entry) => entry.id === id,
    )?.autoMerge;

  it('flips the project named by its key, and the projects handler then reads it on', async () => {
    const { config, deps } = await load();

    const answered = projectAutoMergeFor({ project: 'hive', on: true }, deps);

    expect(answered.projects.find((entry) => entry.id === 'the-hive')?.autoMerge).toBe(true);
    expect(answered.projects.find((entry) => entry.id === 'other')?.autoMerge).toBe(false);
    const listed = projectsDirectoryFor(config.getConfig());
    expect(listed.projects.find((entry) => entry.id === 'the-hive')?.autoMerge).toBe(true);
    expect(listed).toEqual(answered);
    expect(onDisk('the-hive')).toBe(true);
  });

  it('finds a project by its id as well, and turns it off again', async () => {
    const { deps } = await load();

    projectAutoMergeFor({ project: 'the-hive', on: true }, deps);
    const answered = projectAutoMergeFor({ project: 'the-hive', on: false }, deps);

    expect(answered.projects.find((entry) => entry.id === 'the-hive')?.autoMerge).toBe(false);
    expect(onDisk('the-hive')).toBe(false);
  });

  it('refuses an unknown project with a reason naming it, writing nothing', async () => {
    const { deps } = await load();
    const before = readFileSync(path, 'utf8');

    expect(() => projectAutoMergeFor({ project: 'nope', on: true }, deps)).toThrow(ProjectAutoMergeRefused);
    expect(() => projectAutoMergeFor({ project: 'nope', on: true }, deps)).toThrow(/"nope"/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses when the write does not land, without quoting the config\'s reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = { projects: [{ id: 'the-hive', key: 'hive', autoMerge: false }], errors: [] } as unknown as ConfigSnapshot;
    const deps = {
      config: () => snapshot,
      setAutoMerge: () => ({ ...snapshot, errors: ['config: cannot write /Users/someone/.hive/config.json'] }) as ConfigSnapshot,
    };

    let thrown: unknown;
    try {
      projectAutoMergeFor({ project: 'hive', on: true }, deps);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ProjectAutoMergeRefused);
    expect((thrown as Error).message).toBe('the config could not be written, so auto-merge for "the-hive" is unchanged');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/Users/someone/.hive/config.json'));
  });
});
