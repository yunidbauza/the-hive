import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../../../../electron/shared/agent-contract';
import {
  systemPromptFor,
  wakeCommand,
  wakePrompt,
} from '../../../../electron/main/agents/waker';

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'slack-watcher',
  description: 'Watches #incorp-dev.',
  icon: 'ph-robot',
  wake: { on: ['ledger'] },
  skills: [],
  mcp: [],
  tools: ['Read', 'Grep'],
  autonomy: 'ask',
  limits: { turns: 40, rotateAfter: 50, parallel: 1 },
  body: 'Watch the channel and report mentions.',
  ...over,
});

const paths = {
  settings: '/u/hive/claude-hooks.settings.json',
  pluginDir: '/u/hive/plugin',
  mcpConfig: '/u/hive/hive.mcp.json',
  systemPrompt: '/u/hive/agents/slack-watcher.system.md',
  workdir: '/home/me/.hive/work/slack-watcher',
};

const env = {
  base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-leak', HOME: '/home/me' },
  hook: {
    HIVE_SESSION_ID: 'slack-watcher',
    HIVE_HOOK_TOKEN: 'tok',
    HIVE_RECEIVER_URL: 'http://127.0.0.1:5051',
  },
  subscriptionAuth: true,
};

const build = (over: Partial<Parameters<typeof wakeCommand>[0]> = {}) =>
  wakeCommand({
    claudePath: '/opt/bin/claude',
    def: def(),
    newUuid: '11111111-2222-3333-4444-555555555555',
    trigger: 'ledger',
    paths,
    env,
    ...over,
  });

describe('wakeCommand', () => {
  it('spawns the resolved binary, never a bare name', () => {
    expect(build().file).toBe('/opt/bin/claude');
  });

  it('starts a first run with --session-id', () => {
    const args = build().args;

    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
    expect(args).not.toContain('--resume');
  });

  it('resumes a later run with the stored uuid', () => {
    const args = build({ sessionUuid: 'aaaa-bbbb' }).args;

    expect(args[args.indexOf('--resume') + 1]).toBe('aaaa-bbbb');
    expect(args).not.toContain('--session-id');
  });

  it('isolates the run from the user settings that would auto-approve it', () => {
    const args = build().args;

    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('grants the hive tools plus the definition tools', () => {
    const args = build().args;

    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'mcp__hive__*,Read,Grep',
    );
  });

  it('caps turns from the definition limits', () => {
    const args = build().args;

    expect(args[args.indexOf('--max-turns') + 1]).toBe('40');
  });

  it('omits --max-budget-usd when the definition sets no budget', () => {
    expect(build().args).not.toContain('--max-budget-usd');
  });

  it('passes a budget when the definition sets one', () => {
    const args = build({
      def: def({ limits: { turns: 40, budgetUsd: 2.5, rotateAfter: 50, parallel: 1 } }),
    }).args;

    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2.5');
  });

  it('omits --model and --effort when the definition names neither', () => {
    const args = build().args;

    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('passes model and effort when named', () => {
    const args = build({ def: def({ model: 'opus', effort: 'high' }) }).args;

    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('asks for stream-json so the run log can be built', () => {
    const args = build().args;

    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('ends with the wake prompt', () => {
    const args = build().args;

    expect(args[args.length - 1]).toBe(wakePrompt('ledger'));
  });

  it('runs in the agent workdir, not its definition folder', () => {
    expect(build().cwd).toBe('/home/me/.hive/work/slack-watcher');
  });

  it('carries the four HIVE_ variables', () => {
    const result = build().env;

    expect(result['HIVE_SESSION_ID']).toBe('slack-watcher');
    expect(result['HIVE_HOOK_TOKEN']).toBe('tok');
    expect(result['HIVE_RECEIVER_URL']).toBe('http://127.0.0.1:5051');
    expect(result['HIVE_AGENT']).toBe('1');
  });

  it('deletes the auth keys when the user is on subscription auth', () => {
    expect(build().env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('keeps the auth keys when the user is not', () => {
    const result = build({ env: { ...env, subscriptionAuth: false } }).env;

    expect(result['ANTHROPIC_API_KEY']).toBe('sk-leak');
  });

  /*
    The leak these two pin is the one `SESSION_ENV_DENY_PREFIXES` documents:
    launched from inside a Claude Code session, main inherits that session's
    markers, and an agent handed them joins it instead of starting its own.
  */
  it('strips a denied exact key, so a wake is not another session already', () => {
    const leaky = {
      ...env,
      base: { ...env.base, CLAUDECODE: '1', NODE_OPTIONS: '--inspect' },
    };
    const result = build({ env: leaky }).env;

    expect(result['CLAUDECODE']).toBeUndefined();
    expect(result['NODE_OPTIONS']).toBeUndefined();
  });

  it('strips a denied prefix, so --resume still has a transcript to resume', () => {
    const leaky = {
      ...env,
      base: {
        ...env.base,
        CLAUDE_CODE_SESSION_ID: 'outer',
        CLAUDE_CODE_CHILD_SESSION: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
    const result = build({ env: leaky }).env;

    expect(result['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(result['CLAUDE_CODE_CHILD_SESSION']).toBeUndefined();
    expect(result['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });

  it('keeps everything the deny list does not name', () => {
    const result = build().env;

    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/home/me');
  });

  it('routes every permission decision to the hive approve tool', () => {
    const { args } = build();
    const at = args.indexOf('--permission-prompt-tool');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('mcp__hive__approve');
  });

  it('never sets a permission mode, which would skip the prompt tool', () => {
    expect(build().args).not.toContain('--permission-mode');
  });

  it('grants the ledger tools and the definition to the fence', () => {
    const { env } = build({ def: def({ tools: ['Read', 'Grep'] }) });
    expect(JSON.parse(env['HIVE_GRANTS']!)).toEqual([
      'mcp__hive__*',
      'ToolSearch',
      'Read',
      'Grep',
    ]);
  });

  it('adds a one-shot grant for this wake only', () => {
    const withOnce = build({ def: def({ tools: ['Read'] }), grants: ['Bash'] });
    expect(JSON.parse(withOnce.env['HIVE_GRANTS']!)).toEqual([
      'mcp__hive__*',
      'ToolSearch',
      'Read',
      'Bash',
    ]);

    const next = build({ def: def({ tools: ['Read'] }) });
    expect(JSON.parse(next.env['HIVE_GRANTS']!)).toEqual([
      'mcp__hive__*',
      'ToolSearch',
      'Read',
    ]);
  });

  /**
   * Found only by a real `claude` (`pnpm test:agent`), never by this suite on
   * its own: MCP tool schemas are deferred, so the model must call the
   * built-in `ToolSearch` to load `mcp__hive__ledger_read`'s schema before it
   * can call the tool itself. No `def.tools` ever names a built-in, so
   * without an unconditional grant here the fence denied the very first thing
   * every agent's preamble tells it to do, and no agent could ever read its
   * inbox. Pinned here so the next reader who wants to "tidy" this list finds
   * out why before removing it.
   */
  it('grants ToolSearch unconditionally, for a definition that never lists it', () => {
    const { env } = build({ def: def({ tools: ['Read'] }) });
    expect(JSON.parse(env['HIVE_GRANTS']!)).toContain('ToolSearch');
  });

  it('carries a last-turn prompt onto the command line', () => {
    const command = build({ lastTurn: true });

    expect(command.args.at(-1)).toContain(
      'This is your last turn on this session.',
    );
  });

  it('carries a handoff prefix onto the command line', () => {
    const command = build({ handoff: 'I watch #ops.' });

    expect(command.args.at(-1)).toContain('I watch #ops.');
  });

  it('ends a task run’s argv with the task prompt (HIVE-128)', () => {
    const args = build({ kind: 'task', trigger: 'manual', extra: 'review PR 166' }).args;

    expect(args[args.length - 1]).toBe(
      wakePrompt('manual', 'review PR 166', { task: true }),
    );
  });
});

describe('wakePrompt', () => {
  it('names the trigger', () => {
    expect(wakePrompt('ledger')).toContain('You woke because: ledger');
  });

  it('appends the extra when there is one', () => {
    expect(wakePrompt('ledger', 'an answer arrived')).toContain(
      'You woke because: ledger — an answer arrived',
    );
  });

  it('still names the reason on a last turn (HIVE-126)', () => {
    /*
      This branch returned before `extra` was read. Survivable while only the
      scheduler set it — a ledger `extra` names entries the agent re-reads from
      the log — and not once `run <agent> <prompt>` carried a person's words:
      `lastTurn` turns on `forceRotate`/`runsSinceRotate` alone, so one wake in
      fifty woke an agent that was never told what for, while the console
      reported a started run. Through the queue it is worse — `flush` clears
      `pendingWake` before the wake, so no other copy of those words survives.
    */
    const prompt = wakePrompt('manual', 'review PR 1234', { lastTurn: true });

    expect(prompt).toContain('You woke because: manual — review PR 1234.');
    expect(prompt).toContain('This is your last turn on this session.');
  });

  it('asks for a handoff on a last turn', () => {
    const prompt = wakePrompt('schedule', undefined, { lastTurn: true });

    expect(prompt).toContain('This is your last turn on this session.');
    expect(prompt).toContain('ledger_handoff');
    /*
      The normal **instruction** is replaced, not appended to — that is what
      this pins, and it still holds: the "read your ledger inbox, then carry
      out the instructions you were given" sentence is absent here.

      It used to be asserted as the absence of `You woke because`, which
      conflated the instruction with the *reason*. HIVE-126 separated them: a
      wake with no `extra` still says nothing beyond the trigger, and one
      carrying a person's prompt has to name it, because `lastTurn` turns on
      `forceRotate`/`runsSinceRotate` and would otherwise swallow the words on
      one wake in fifty.
    */
    expect(prompt).not.toContain('Read your ledger inbox');
    expect(prompt.startsWith('You woke because: schedule. This is your last turn')).toBe(
      true,
    );
  });

  it('opens a fresh session with the previous one’s handoff', () => {
    const prompt = wakePrompt('schedule', undefined, {
      handoff: 'I watch #ops.',
    });

    expect(prompt).toContain(
      'You are continuing from a previous session of yourself.',
    );
    expect(prompt).toContain('I watch #ops.');
    // …and then the ordinary wake instruction still follows it.
    expect(prompt).toContain('You woke because: schedule.');
    expect(prompt.indexOf('I watch #ops.')).toBeLessThan(
      prompt.indexOf('You woke because'),
    );
  });

  it('is unchanged when neither is asked for', () => {
    expect(wakePrompt('manual')).toBe(wakePrompt('manual', undefined, {}));
  });

  /*
    The defect this wording replaces. "Read your ledger inbox first, then do
    your job" left "your job" undefined at the only moment it mattered: an
    agent woken on an interval with an empty inbox concluded there was nothing
    to do and ended its turn. Measured against a real agent — sixteen
    consecutive interval wakes, each ~4s, none of which carried out the
    standing instruction in its own body.

    The instructions are named explicitly, and the inbox is demoted from "first"
    to one of two inputs, because an empty inbox must not read as an empty turn.
  */
  it('names the agent’s own instructions as the work of the wake', () => {
    const prompt = wakePrompt('interval');

    expect(prompt).toContain('instructions');
    expect(prompt).not.toContain('then do your job');
  });

  it('still says an empty inbox is not an empty turn', () => {
    expect(wakePrompt('interval')).toContain(
      'An empty inbox does not mean there is nothing to do',
    );
  });

  it('tells a task run what it is, and what not to do (HIVE-128)', () => {
    const prompt = wakePrompt('manual', 'review PR 166', { task: true });

    expect(prompt).toContain('You woke because: manual — review PR 166.');
    expect(prompt).toContain('This is a task run');
    expect(prompt).toContain('do not act on your ledger inbox');
    expect(prompt).toContain('ledger_done');
    expect(prompt).toContain('ledger_failed');
    expect(prompt).not.toContain('Read your ledger inbox, then carry out');
    expect(prompt).not.toContain('ledger_handoff');
  });

  /*
    The last-turn branch names the work the same way the ordinary one does. It
    was missed when the other two strings were reworded and still said "do your
    normal work if something is waiting" — the inbox-conditional framing this
    change exists to remove, left alive on the one wake in `rotate_after` that
    takes this branch.
  */
  it('asks a last turn to carry out the instructions too', () => {
    const prompt = wakePrompt('schedule', undefined, { lastTurn: true });

    expect(prompt).toContain('This is your last turn on this session.');
    expect(prompt).toContain('Carry out your instructions');
    expect(prompt).not.toContain('if something is waiting');
  });
});

describe('systemPromptFor', () => {
  it('puts the app-owned preamble above the definition body', () => {
    const text = systemPromptFor('PREAMBLE', def());

    expect(text.indexOf('PREAMBLE')).toBeLessThan(
      text.indexOf('Watch the channel'),
    );
  });

  /*
    `autonomy` parsed into the definition and was then read by nothing at all —
    not the system prompt, not the argv, not the fence — while the form's help
    text described in detail the behaviour it was supposed to produce. These
    two tests are what make the field mean something.
  */
  it('tells an ask-first agent to check before acting', () => {
    const text = systemPromptFor('PREAMBLE', def({ autonomy: 'ask' }));

    expect(text).toContain('ledger_ask');
    expect(text).toContain('before you act');
  });

  it('tells an act-first agent to proceed and report', () => {
    const text = systemPromptFor('PREAMBLE', def({ autonomy: 'act' }));

    expect(text).toContain('Proceed without asking');
    expect(text).not.toContain('before you act');
  });

  /*
    The body stays last. It is the part the *user* wrote, and an app-owned
    sentence appended below it would read as theirs — and, worse, would be the
    final instruction the model sees.
  */
  it('keeps the body below the separator, after the autonomy clause', () => {
    const text = systemPromptFor('PREAMBLE', def({ autonomy: 'act' }));

    expect(text.indexOf('Proceed without asking')).toBeLessThan(
      text.indexOf('---'),
    );
    expect(text.indexOf('---')).toBeLessThan(text.indexOf('Watch the channel'));
    expect(text.trimEnd().endsWith('Watch the channel and report mentions.')).toBe(
      true,
    );
  });
});
