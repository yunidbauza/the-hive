// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SHELL,
  type ConfigSnapshot,
  type ProjectConfig,
} from '../../../../electron/shared/config-contract';
import {
  diagnoseCommand,
  effectiveRuntime,
} from '../../../../electron/main/config/runtime';

/**
 * Real files throughout (story 104), matching `write.test.ts`.
 *
 * The diagnostic's whole job is to report what is on disk and executable — a
 * mocked `fs` would assert the mock rather than the behaviour, and the one bug
 * worth catching here is a candidate that exists but is not executable.
 */

let dir: string;

const snapshot = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot => ({
  configPath: '/tmp/hive/config.json',
  templateWritten: false,
  shell: DEFAULT_SHELL,
  claudeCommand: DEFAULT_CLAUDE_COMMAND,
  projects: [],
  notifications: { ...DEFAULT_NOTIFICATIONS },
  jira: { ...DEFAULT_JIRA },
  subscriptionAuth: true,
  sessionMetrics: true,
  errors: [],
  ...over,
});

const project = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  id: 'apfm-web',
  name: 'apfm-web',
  path: '/tmp/apfm-web',
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-runtime-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an executable file and return its path. */
function executable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

/** Write a file that is present but not executable. */
function plainFile(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, 'not executable\n');
  chmodSync(file, 0o644);
  return file;
}

describe('effectiveRuntime', () => {
  it('falls back to the top-level values when a project overrides nothing', () => {
    const runtime = effectiveRuntime(snapshot(), project());

    expect(runtime).toMatchObject({
      shell: DEFAULT_SHELL,
      claudeCommand: DEFAULT_CLAUDE_COMMAND,
      env: {},
      shellFromProject: false,
      commandFromProject: false,
    });
  });

  it('prefers a project override and says where it came from', () => {
    const runtime = effectiveRuntime(
      snapshot({ shell: '/bin/zsh' }),
      project({ shell: '/bin/bash', claudeCommand: '/opt/claude' }),
    );

    expect(runtime).toMatchObject({
      shell: '/bin/bash',
      claudeCommand: '/opt/claude',
      shellFromProject: true,
      commandFromProject: true,
    });
  });

  it('resolves against the top level when there is no project at all', () => {
    const runtime = effectiveRuntime(snapshot({ shell: '/bin/zsh' }), null);

    expect(runtime.shell).toBe('/bin/zsh');
    expect(runtime.shellFromProject).toBe(false);
  });

  it('copies the env rather than handing out the snapshot’s own map', () => {
    const entry = project({ env: { FOO: 'bar' } });
    const runtime = effectiveRuntime(snapshot(), entry);

    runtime.env.FOO = 'mutated';

    // The caller passes this to the pty-host; sharing the cached config's map
    // would let a mutation downstream edit the config the app is running on.
    expect(entry.env).toEqual({ FOO: 'bar' });
  });
});

describe('diagnoseCommand — searching PATH', () => {
  it('finds an executable and reports where', () => {
    const bin = join(dir, 'bin');
    const claude = executable(bin, 'claude');

    const result = diagnoseCommand(
      effectiveRuntime(snapshot(), null),
      null,
      { PATH: bin },
    );

    expect(result.resolved).toBe(claude);
    expect(result.isPath).toBe(false);
    expect(result.probes).toEqual([{ directory: bin, found: true }]);
  });

  it('reports the first match when several directories have one', () => {
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    const winner = executable(first, 'claude');
    executable(second, 'claude');

    const result = diagnoseCommand(effectiveRuntime(snapshot(), null), null, {
      PATH: [first, second].join(delimiter),
    });

    // First match wins, exactly as a shell resolves it.
    expect(result.resolved).toBe(winner);
    expect(result.probes).toHaveLength(2);
  });

  it('flags a candidate that exists but is not executable', () => {
    const bin = join(dir, 'bin');
    plainFile(bin, 'claude');

    const result = diagnoseCommand(effectiveRuntime(snapshot(), null), null, {
      PATH: bin,
    });

    // The genuinely confusing case: the file is right there and the only reason
    // it does not run is a missing +x bit.
    expect(result.resolved).toBeNull();
    expect(result.probes).toEqual([
      { directory: bin, found: false, notExecutable: true },
    ]);
  });

  it('reports every directory searched when nothing is found', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);

    const result = diagnoseCommand(effectiveRuntime(snapshot(), null), null, {
      PATH: [a, b].join(delimiter),
    });

    expect(result.resolved).toBeNull();
    expect(result.probes.map((probe) => probe.directory)).toEqual([a, b]);
    expect(result.probes.every((probe) => !probe.found)).toBe(true);
  });

  it('skips empty PATH entries rather than probing the cwd', () => {
    const bin = join(dir, 'bin');
    executable(bin, 'claude');

    const result = diagnoseCommand(effectiveRuntime(snapshot(), null), null, {
      PATH: `${bin}${delimiter}${delimiter}`,
    });

    // An empty entry means "the current directory" to some shells, and this
    // process does not share a cwd with the session.
    expect(result.probes).toHaveLength(1);
  });

  it('searches the project’s own PATH, not the process one', () => {
    const bin = join(dir, 'bin');
    const claude = executable(bin, 'claude');

    const result = diagnoseCommand(
      effectiveRuntime(snapshot(), project({ env: { PATH: bin } })),
      'apfm-web',
      { PATH: '/nowhere' },
    );

    // A project that sets its own PATH must be diagnosed against that PATH, or
    // the diagnostic describes a session nobody is running.
    expect(result.path).toBe(bin);
    expect(result.resolved).toBe(claude);
    expect(result.projectId).toBe('apfm-web');
  });

  it('reports an empty PATH rather than throwing', () => {
    const result = diagnoseCommand(effectiveRuntime(snapshot(), null), null, {});

    expect(result.path).toBe('');
    expect(result.probes).toEqual([]);
    expect(result.resolved).toBeNull();
  });
});

describe('diagnoseCommand — a command used as a path', () => {
  it('does not consult PATH for an absolute command', () => {
    const claude = executable(join(dir, 'opt'), 'claude');

    const result = diagnoseCommand(
      effectiveRuntime(snapshot({ claudeCommand: claude }), null),
      null,
      { PATH: '/nowhere' },
    );

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBe(claude);
    // Reporting "not found on PATH" here would send the user editing a PATH
    // that was never consulted.
    expect(result.probes).toEqual([]);
  });

  it('reports an absolute command that is missing', () => {
    const result = diagnoseCommand(
      effectiveRuntime(snapshot({ claudeCommand: join(dir, 'absent') }), null),
      null,
      { PATH: '/nowhere' },
    );

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBeNull();
  });

  it('leaves a relative path unresolved rather than guessing a cwd', () => {
    const result = diagnoseCommand(
      effectiveRuntime(snapshot({ claudeCommand: './bin/claude' }), null),
      null,
      { PATH: '/nowhere' },
    );

    // It would be resolved against the session's cwd — the project directory —
    // which this process does not share.
    expect(result.isPath).toBe(true);
    expect(result.resolved).toBeNull();
  });
});
