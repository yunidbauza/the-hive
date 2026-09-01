// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWakeCommand,
  type WakeCommandDeps,
  type WakeFs,
} from '../../../../electron/main/agents/wake-command';
import type { AgentState } from '../../../../electron/main/agents/state';
import type { McpServerSpec } from '../../../../electron/main/mcp/agent-config';
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
  clearSlackNeedsAuth: vi.fn(() => []),
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
    // Unused by every test below: `AGENT_MD` has no `mcp:` field, so
    // `def.mcp.length > 0` never fires and neither dep is ever called.
    hiveServer: () => ({
      command: '/App',
      args: ['/host.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
    agentMcpFile: (name) => `/data/hive/agents/${name}.mcp.json`,
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
    // Two under `rotate_after: 5`, so this is an ordinary wake, not a goodbye.
    expect(built.lastTurn).toBe(false);
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
   * A wake that could not be prepared has changed nothing.
   *
   * The ordering this pins predates HIVE-122 — recording a rotation before the
   * `mkdir`/`write` meant a transient fs error threw away the session uuid
   * *and* returned no command: no run, and the conversation gone anyway. The
   * crossing wake no longer writes anything at all, so the invariant is now
   * that a failed prepare leaves the counter and the uuid exactly as it found
   * them, whichever side of the threshold they are on.
   */
  it('leaves the counter and the uuid untouched when preparing the run fails', () => {
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

/**
 * Rotation as a handover rather than an amnesia (HIVE-122).
 *
 * The wake that crosses `rotate_after` used to clear the uuid and start fresh
 * on the spot. It now spends that wake asking the agent for a handoff, still
 * resumed on the old conversation — and writes nothing, because whether the
 * rotation happens is the *close's* call. `pendingSession` is the other half:
 * a rotation already decided, waiting for a wake to start it.
 *
 * `AGENT_MD` above declares `rotate_after: 5`.
 */
describe('the handoff wake', () => {
  /** The disk this wake cannot write its system prompt to. */
  const failWrites = (): WakeFs => ({
    ...fs,
    write: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });

  it('resumes the old session and asks for a handoff when the counter is up', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 50,
      runs: [],
      sessionUuid: '9f3c1e2a',
    };

    const result = build()('slack-watcher', 'schedule');

    expect('problem' in result).toBe(false);

    if ('problem' in result) return;

    expect(result.lastTurn).toBe(true);
    expect(result.args).toContain('--resume');
    expect(result.args).toContain('9f3c1e2a');
    expect(result.args).not.toContain('--session-id');
    expect(result.sessionUuid).toBe('9f3c1e2a');
    expect(result.args.at(-1)).toContain('This is your last turn on this session.');
  });

  it('leaves the counter and the uuid alone — the close decides', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 50,
      runs: [],
      sessionUuid: '9f3c1e2a',
    };

    build()('slack-watcher', 'schedule');

    expect(stored['slack-watcher']?.runsSinceRotate).toBe(50);
    expect(stored['slack-watcher']?.sessionUuid).toBe('9f3c1e2a');
  });

  it('starts the pending session and carries its handoff', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
      sessionUuid: '9f3c1e2a',
      pendingSession: { uuid: 'b2e1-new', handoff: 'I watch #ops.' },
    };

    const result = build()('slack-watcher', 'schedule');

    if ('problem' in result) throw new Error(result.problem);

    expect(result.lastTurn).toBe(false);
    expect(result.args).toContain('--session-id');
    expect(result.args).toContain('b2e1-new');
    expect(result.args).not.toContain('--resume');
    expect(result.sessionUuid).toBe('b2e1-new');
    expect(result.args.at(-1)).toContain('I watch #ops.');
    // Consumed, so the wake after this one resumes normally.
    expect(stored['slack-watcher']?.pendingSession).toBeUndefined();
  });

  it('honours a forced rotation, and clears the flag', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
      sessionUuid: '9f3c1e2a',
      forceRotate: true,
    };

    const result = build()('slack-watcher', 'manual');

    if ('problem' in result) throw new Error(result.problem);

    expect(result.lastTurn).toBe(true);
    expect(stored['slack-watcher']?.forceRotate).toBeUndefined();
  });

  /*
    A forced rotation on an agent that has never run degrades to an ordinary
    first wake (HIVE-122).

    Only a run sets `sessionUuid`, so the counter path can never reach this —
    but the console's `rotate` verb can, on an agent installed five minutes ago.
    Without the `sessionUuid` term the wake would be a *last turn* on a brand
    new `--session-id` session: an agent asked to summarise a conversation that
    has not happened yet, and a handoff that could only be fiction.
  */
  it('degrades a forced rotation on a never-run agent to a first wake', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
      forceRotate: true,
    };

    const result = build()('slack-watcher', 'manual');

    if ('problem' in result) throw new Error(result.problem);

    expect(result.lastTurn).toBe(false);
    expect(result.args).toContain('--session-id');
    expect(result.args).not.toContain('--resume');
    // Consumed all the same: the fresh session the user asked for is the one
    // this wake starts, so leaving the flag armed would rotate again next time.
    expect(stored['slack-watcher']?.forceRotate).toBeUndefined();
  });

  it('keeps the pending session when preparing the run fails', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
      pendingSession: { uuid: 'b2e1-new', handoff: 'I watch #ops.' },
    };

    const built = build({ fs: failWrites() })('slack-watcher', 'schedule');

    expect('problem' in built).toBe(true);
    // Nothing consumed: a full disk must not destroy the handoff.
    expect(stored['slack-watcher']?.pendingSession).toEqual({
      uuid: 'b2e1-new',
      handoff: 'I watch #ops.',
    });
  });

  it('never both asks for a handoff and starts a fresh session', () => {
    stored['slack-watcher'] = {
      status: 'sleeping',
      runsSinceRotate: 50,
      runs: [],
      pendingSession: { uuid: 'b2e1-new', handoff: 'I watch #ops.' },
    };

    const result = build()('slack-watcher', 'schedule');

    if ('problem' in result) throw new Error(result.problem);

    expect(result.lastTurn).toBe(false);
    expect(result.args).toContain('--session-id');
  });
});

/**
 * A per-agent `--mcp-config`, for a definition that names an integration
 * (HIVE-123, task 2).
 *
 * A self-contained fixture set rather than a reuse of `build()` above: that
 * one's `AGENT_MD` has no `mcp:` field on purpose, so it cannot exercise this
 * branch without being rewritten out from under the rotation tests it exists
 * for.
 */
describe('a per-agent mcp config', () => {
  const HIVE: McpServerSpec = {
    command: '/App',
    args: ['/host.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };

  /**
   * An AGENT.md body, customisable by the one field each test varies.
   *
   * `name:` is a placeholder rather than a fixed value: `deps()`'s `read`
   * fills it in with whatever folder was actually asked for, so this same
   * source works whichever agent name a test wakes.
   */
  function agentSource(over: { mcp?: string; tools?: string } = {}): string {
    const tools = over.tools ?? '[Read, Bash]';
    const mcpLine = over.mcp === undefined ? '' : `mcp: ${over.mcp}\n`;

    return `---
name: {{name}}
description: Watches the channel.
icon: ChatCircleDots
model: sonnet
tools: ${tools}
${mcpLine}limits:
  turns: 12
  rotate_after: 5
---
Read the channel and report.
`;
  }

  /** A `WakeFs.read` that serves `source` for whichever folder was asked for. */
  function readerFor(source: string): WakeFs['read'] {
    return (path) => {
      const match = /\/agents\/([^/]+)\/AGENT\.md$/.exec(path);

      if (match === null) throw new Error(`ENOENT: ${path}`);

      return source.replace('{{name}}', match[1]!);
    };
  }

  /** `WakeCommandDeps`, fixed across these tests apart from what each varies. */
  function deps(
    over: {
      source?: string;
      fs?: Partial<WakeFs>;
      hiveServer?: () => McpServerSpec | null;
    } = {},
  ): WakeCommandDeps {
    const source = over.source ?? agentSource();
    const localState: Record<string, AgentRunState> = {};

    return {
      agentsRoot: () => '/home/u/.hive/agents',
      workdir: (name) => `/home/u/.hive/work/${name}`,
      promptFile: (name) => `/userData/hive/agents/${name}.system.md`,
      pluginDir: () => '/userData/hive/plugin',
      agentSettingsPath: () => '/userData/hive/claude-agent.settings.json',
      mcpConfig: () => '/userData/hive/hive.mcp.json',
      hiveServer: over.hiveServer ?? (() => HIVE),
      agentMcpFile: (name) => `/userData/hive/agents/${name}.mcp.json`,
      hookEnv: (name) => ({ HIVE_SESSION_ID: name, HIVE_HOOK_TOKEN: 'tok' }),
      claudeCommand: () => '/usr/local/bin/claude',
      subscriptionAuth: () => true,
      state: {
        all: () => ({ ...localState }),
        read: (name) => localState[name] ?? EMPTY,
        patch: (name, change) => {
          const next = { ...(localState[name] ?? EMPTY), ...change };

          localState[name] = next;

          return next;
        },
        recordRun: vi.fn(),
        clearSlackNeedsAuth: vi.fn(() => []),
        forget: (name) => {
          delete localState[name];
        },
        carry: (from, to) => {
          const entry = localState[from];

          if (entry === undefined) return;

          localState[to] = entry;
          delete localState[from];
        },
        flush: vi.fn(),
        dispose: vi.fn(),
      },
      env: () => ({ PATH: '/usr/local/bin', HOME: '/home/u' }),
      newUuid: () => 'minted-uuid',
      pendingGrants: () => [],
      isExecutable: (path) => path === '/usr/local/bin/claude',
      fs: {
        read: readerFor(source),
        write: () => {},
        mkdir: () => {},
        ...over.fs,
      },
    };
  }

  it('points --mcp-config at a per-agent file when the definition names an integration', () => {
    const written = new Map<string, string>();
    const build = createWakeCommand(
      deps({
        source: agentSource({ mcp: '[slack]', tools: '[Read, mcp__slack__*]' }),
        fs: {
          write: (path, body) => {
            written.set(path, body);
          },
        },
      }),
    );

    const command = build('slack-watcher', 'interval');

    if ('problem' in command) throw new Error(command.problem);

    const flag = command.args[command.args.indexOf('--mcp-config') + 1];

    expect(flag).toBe('/userData/hive/agents/slack-watcher.mcp.json');
    expect(JSON.parse(written.get(flag ?? '') ?? '{}').mcpServers).toHaveProperty(
      'slack',
    );
  });

  it('keeps the shared file for an agent with an empty mcp:', () => {
    const written = new Map<string, string>();
    const build = createWakeCommand(
      deps({
        source: agentSource({ tools: '[Read]' }),
        fs: {
          write: (path, body) => {
            written.set(path, body);
          },
        },
      }),
    );

    const command = build('drone', 'interval');

    if ('problem' in command) throw new Error(command.problem);

    expect(command.args[command.args.indexOf('--mcp-config') + 1]).toBe(
      '/userData/hive/hive.mcp.json',
    );
    expect([...written.keys()]).not.toContain('/userData/hive/agents/drone.mcp.json');
  });

  it('refuses the wake when the hive descriptor is unavailable', () => {
    const build = createWakeCommand(
      deps({ source: agentSource({ mcp: '[slack]' }), hiveServer: () => null }),
    );

    expect(build('slack-watcher', 'interval')).toEqual({
      problem:
        'The ledger tools are not configured yet, and an agent reads its ' +
        'inbox before anything else. Try again in a moment.',
    });
  });
});
