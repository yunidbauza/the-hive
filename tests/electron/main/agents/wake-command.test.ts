// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWakeCommand,
  type WakeCommandDeps,
  type WakeFs,
} from '../../../../electron/main/agents/wake-command';
import type { AgentState } from '../../../../electron/main/agents/state';
import type { AgentRunState } from '../../../../electron/shared/agent-contract';

/**
 * The seam between a *name* and an argv (HIVE-115, task 9).
 *
 * `waker.test.ts` already pins the flags; what belongs here is everything that
 * happens on the way to calling it — which definition is read, whether the
 * binary resolved, what is written to disk before the spawn, and the rotation
 * rule that decides whether the run resumes a conversation or starts one.
 *
 * The filesystem is injected, so these assertions are about *what* was written
 * where, with no temp directory to clean up.
 */

const AGENT_MD = `---
name: slack-watcher
description: Watches the channel.
icon: ChatCircleDots
model: sonnet
tools: [Read, Bash]
limits:
  turns: 12
  rotate_after: 5
---
Read the channel and report.
`;

let files: Record<string, string>;
let written: Record<string, string>;
let made: string[];
let stored: Record<string, AgentRunState>;

const fs: WakeFs = {
  read: (path) => {
    const found = files[path];

    if (found === undefined) throw new Error(`ENOENT: ${path}`);

    return found;
  },
  write: (path, text) => {
    written[path] = text;
  },
  mkdir: (path) => {
    made.push(path);
  },
};

const EMPTY: AgentRunState = { status: 'sleeping', runsSinceRotate: 0, runs: [] };

const state = (): AgentState => ({
  all: () => ({ ...stored }),
  read: (name) => stored[name] ?? EMPTY,
  patch: (name, change) => {
    const next = { ...(stored[name] ?? EMPTY), ...change };

    stored[name] = next;

    return next;
  },
  recordRun: vi.fn(),
  forget: (name) => {
    delete stored[name];
  },
  carry: (from, to) => {
    const entry = stored[from];

    if (entry === undefined) return;

    stored[to] = entry;
    delete stored[from];
  },
  flush: vi.fn(),
  dispose: vi.fn(),
});

const build = (over: Partial<WakeCommandDeps> = {}) =>
  createWakeCommand({
    agentsRoot: () => '/home/u/.hive/agents',
    workdir: (name) => `/home/u/.hive/work/${name}`,
    promptFile: (name) => `/data/hive/agents/${name}.system.md`,
    pluginDir: () => '/data/hive/plugin',
    agentSettingsPath: () => '/data/hive/claude-agent.settings.json',
    mcpConfig: () => '/data/hive/hive.mcp.json',
    hookEnv: (name) => ({ HIVE_SESSION_ID: name, HIVE_HOOK_TOKEN: 'tok' }),
    claudeCommand: () => '/usr/local/bin/claude',
    subscriptionAuth: () => true,
    state: state(),
    env: () => ({ PATH: '/usr/local/bin', HOME: '/home/u' }),
    newUuid: () => 'minted-uuid',
    pendingGrants: () => [],
    fs,
    isExecutable: (path) => path === '/usr/local/bin/claude',
    ...over,
  });

beforeEach(() => {
  files = { '/home/u/.hive/agents/slack-watcher/AGENT.md': AGENT_MD };
  written = {};
  made = [];
  stored = {};
});

describe('createWakeCommand', () => {
  it('builds the argv from the definition on disk', () => {
    const built = build()('slack-watcher', 'manual');

    expect('problem' in built).toBe(false);

    if ('problem' in built) return;

    expect(built.file).toBe('/usr/local/bin/claude');
    expect(built.args).toContain('--session-id');
    expect(built.args).toContain('minted-uuid');
    expect(built.args.join(' ')).toContain('--model sonnet');
    expect(built.args.join(' ')).toContain('--max-turns 12');
    expect(built.cwd).toBe('/home/u/.hive/work/slack-watcher');
  });

  it('writes the preamble and the body into the generated system prompt', () => {
    build()('slack-watcher', 'manual');

    const prompt = written['/data/hive/agents/slack-watcher.system.md'];

    expect(prompt).toContain('You are a background agent in The Hive.');
    expect(prompt).toContain('Read the channel and report.');
  });

  it('creates the working directory and the prompt directory before spawning', () => {
    build()('slack-watcher', 'manual');

    expect(made).toEqual(['/home/u/.hive/work/slack-watcher', '/data/hive/agents']);
  });

  it('carries the trigger into the wake prompt', () => {
    const built = build()('slack-watcher', 'ledger', 'a12 was answered');

    if ('problem' in built) throw new Error('expected a command');

    expect(built.args[built.args.length - 1]).toContain(
      'You woke because: ledger — a12 was answered',
    );
  });

  it('resumes the stored conversation and reports the uuid it invoked', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 2,
      runs: [],
      sessionUuid: 'earlier-uuid',
    };

    const built = build()('slack-watcher', 'manual');

    if ('problem' in built) throw new Error('expected a command');

    expect(built.args.join(' ')).toContain('--resume earlier-uuid');
    expect(built.args).not.toContain('--session-id');
    expect(built.sessionUuid).toBe('earlier-uuid');
  });

  it('rotates once the run count reaches rotate_after, and resets the counter', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 5,
      runs: [],
      sessionUuid: 'stale-uuid',
    };

    const built = build()('slack-watcher', 'manual');

    if ('problem' in built) throw new Error('expected a command');

    expect(built.args.join(' ')).toContain('--session-id minted-uuid');
    expect(built.args.join(' ')).not.toContain('stale-uuid');
    expect(built.sessionUuid).toBe('minted-uuid');
    // Cleared with the counter: a rotating run that dies before it emits a
    // `result` must not resume the conversation the rotation left behind.
    expect(stored['slack-watcher']?.runsSinceRotate).toBe(0);
    expect(stored['slack-watcher']?.sessionUuid).toBeUndefined();
  });

  it('refuses an agent that is not on disk', () => {
    expect(build()('ghost', 'manual')).toEqual({
      problem: 'There is no agent called ghost.',
    });
  });

  it('refuses a definition that cannot be parsed, naming the field', () => {
    files['/home/u/.hive/agents/slack-watcher/AGENT.md'] =
      '---\nname: slack-watcher\nicon: Robot\n---\nbody\n';

    const built = build()('slack-watcher', 'manual');

    expect(built).toEqual({ problem: 'description: Required.' });
  });

  /**
   * The wake-time parse deliberately does *not* re-check skills against the
   * machine. A renamed folder or an unscanned `~/.claude` would otherwise
   * refuse to wake the agent at all, where the honest consequence of a missing
   * skill is an agent that runs without it.
   */
  it('wakes an agent naming a skill this machine has never heard of', () => {
    files['/home/u/.hive/agents/slack-watcher/AGENT.md'] = AGENT_MD.replace(
      'tools: [Read, Bash]',
      'tools: [Read]\nskills: [some-plugin:vanished]',
    );

    expect('problem' in build()('slack-watcher', 'manual')).toBe(false);
  });

  it('refuses when the agent settings file has not been written', () => {
    const built = build({ agentSettingsPath: () => null })(
      'slack-watcher',
      'manual',
    );

    expect(built).toMatchObject({
      problem: expect.stringContaining('agent settings file'),
    });
  });

  it('starts an agent with the agent settings file, not the session one', () => {
    const built = build({
      agentSettingsPath: () => '/data/hive/claude-agent.settings.json',
    })('slack-watcher', 'manual');

    if ('problem' in built) throw new Error('expected a command');

    expect(built.args[built.args.indexOf('--settings') + 1]).toBe(
      '/data/hive/claude-agent.settings.json',
    );
  });

  it("carries this wake's one-shot grants into the command", () => {
    // `WebFetch`, not `Bash` — the fixture's own `tools: [Read, Bash]`
    // (`AGENT_MD` above) already grants `Bash`, so asserting that would pass
    // even with `grants: deps.pendingGrants(name)` deleted from the
    // `wakeCommand` call. A tool the definition does not list is the only
    // choice that actually discriminates the wiring this test exists to
    // prove.
    const built = build({ pendingGrants: () => ['WebFetch'] })(
      'slack-watcher',
      'manual',
    );

    if ('problem' in built) throw new Error('expected a command');

    expect(JSON.parse(built.env['HIVE_GRANTS']!)).toContain('WebFetch');
  });

  it('refuses when the MCP config has not been written', () => {
    const built = build({ mcpConfig: () => null })('slack-watcher', 'manual');

    expect(built).toMatchObject({
      problem: expect.stringContaining('ledger tools'),
    });
  });

  it('passes the resolver failure through unchanged', () => {
    const built = build({ claudeCommand: () => 'claude --tel' })(
      'slack-watcher',
      'manual',
    );

    expect(built).toMatchObject({
      problem: expect.stringContaining('carries arguments'),
    });
  });

  it('reports a disk it cannot write to rather than spawning anyway', () => {
    const built = build({
      fs: {
        ...fs,
        write: () => {
          throw new Error('EROFS: read-only file system');
        },
      },
    })('slack-watcher', 'manual');

    expect(built).toEqual({
      problem: 'Could not prepare the run: EROFS: read-only file system',
    });
  });

  /**
   * A rotation that could not be prepared has not happened.
   *
   * Recording it before the `mkdir`/`write` meant a transient fs error threw
   * away the session uuid *and* returned no command: no run, and the
   * conversation gone anyway, with the next wake starting fresh for a reason
   * the user could never see.
   */
  it('keeps the rotation unrecorded when preparing the run fails', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 5,
      runs: [],
      sessionUuid: 'stale-uuid',
    };

    const built = build({
      fs: {
        ...fs,
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    })('slack-watcher', 'manual');

    expect('problem' in built).toBe(true);
    expect(stored['slack-watcher']?.sessionUuid).toBe('stale-uuid');
    expect(stored['slack-watcher']?.runsSinceRotate).toBe(5);
  });

  it('strips the API-key variables when the user is on a subscription', () => {
    const built = build({
      env: () => ({
        PATH: '/usr/local/bin',
        ANTHROPIC_API_KEY: 'sk-should-not-travel',
      }),
    })('slack-watcher', 'manual');

    if ('problem' in built) throw new Error('expected a command');

    expect(built.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(built.env['HIVE_SESSION_ID']).toBe('slack-watcher');
    expect(built.env['HIVE_AGENT']).toBe('1');
  });
});
