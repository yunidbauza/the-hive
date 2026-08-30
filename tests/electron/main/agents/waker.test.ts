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
  limits: { turns: 40, rotateAfter: 50 },
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
      def: def({ limits: { turns: 40, budgetUsd: 2.5, rotateAfter: 50 } }),
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
});

describe('systemPromptFor', () => {
  it('puts the app-owned preamble above the definition body', () => {
    const text = systemPromptFor('PREAMBLE', def());

    expect(text.indexOf('PREAMBLE')).toBeLessThan(
      text.indexOf('Watch the channel'),
    );
  });
});
