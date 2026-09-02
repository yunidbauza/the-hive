import { describe, expect, it } from 'vitest';

import { LEDGER_KINDS } from '@shared/ledger-contract';
import {
  AGENTS_TOOL,
  APPROVE_TOOL,
  LEDGER_TOOLS,
  LEDGER_TOOL_NAMES,
} from '@shared/ledger-tools';
import { matches } from '@shared/permission-rules';

describe('ledger-tools', () => {
  it('ships exactly the nine tools the epic names', () => {
    expect(LEDGER_TOOL_NAMES).toEqual([
      'ledger_read',
      'ledger_post',
      'ledger_ask',
      'ledger_answer',
      'ledger_claim',
      'ledger_release',
      'ledger_done',
      'ledger_failed',
      'ledger_handoff',
    ]);
  });

  it('gives every tool a model-facing description', () => {
    for (const tool of LEDGER_TOOLS) {
      // Long enough to say when to use it, not just what it is called.
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('tells the model that ledger_read comes first on a wake', () => {
    const read = LEDGER_TOOLS.find((tool) => tool.name === 'ledger_read');
    expect(read?.description).toMatch(/first/i);
  });

  it('warns that an ask ends the caller turn', () => {
    const ask = LEDGER_TOOLS.find((tool) => tool.name === 'ledger_ask');
    expect(ask?.description).toMatch(/ends your turn/i);
  });

  /**
   * `quote` is what lets an agent's ask render as a draft-for-approval card
   * (HIVE-118) rather than a plain question — declared optional because most
   * asks are not that, and `required` staying untouched proves it.
   */
  it('declares an optional string quote on ledger_ask', () => {
    const ask = LEDGER_TOOLS.find((tool) => tool.name === 'ledger_ask');
    expect(ask?.inputSchema.properties?.quote).toMatchObject({ type: 'string' });
    expect(ask?.inputSchema.required).not.toContain('quote');
  });

  it('gives every tool an object input schema', () => {
    for (const tool of LEDGER_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  it('requires a body on every tool that writes one', () => {
    for (const name of ['ledger_post', 'ledger_ask', 'ledger_answer', 'ledger_done', 'ledger_failed']) {
      const tool = LEDGER_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toContain('body');
    }
  });

  it('requires a task on the claim pair', () => {
    for (const name of ['ledger_claim', 'ledger_release']) {
      const tool = LEDGER_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual(['task']);
    }
  });

  /**
   * `ledger_post`'s handler has always forwarded `thread` (HIVE-112
   * self-review) — the schema just never told the model the capability
   * existed. `ledger_done` and `ledger_failed` already declare it.
   */
  it('declares thread on every tool whose handler can carry one', () => {
    for (const name of ['ledger_post', 'ledger_done', 'ledger_failed']) {
      const tool = LEDGER_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty('thread');
    }
  });

  it('names only kinds the ledger accepts', () => {
    // Every tool maps to one kind; a typo here is a 400 at runtime.
    for (const kind of [
      'post',
      'ask',
      'answer',
      'claim',
      'release',
      'done',
      'failed',
      'handoff',
    ]) {
      expect(LEDGER_KINDS).toContain(kind);
    }
  });

  it('offers ledger_handoff, requiring only a body', () => {
    const tool = LEDGER_TOOLS.find((t) => t.name === 'ledger_handoff');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(['body']);
    // A handoff is addressed to your own next session; `to` would be noise.
    expect(tool?.inputSchema.properties).not.toHaveProperty('to');
  });
});

describe('AGENTS_TOOL', () => {
  it('is named for the short mcp__hive__ form the model calls', () => {
    expect(AGENTS_TOOL.name).toBe('agents');
  });

  it('stays outside LEDGER_TOOLS, which is the ledger vocabulary', () => {
    expect(LEDGER_TOOL_NAMES).not.toContain('agents');
    expect(LEDGER_TOOLS).not.toContain(AGENTS_TOOL);
    expect(AGENTS_TOOL).not.toBe(APPROVE_TOOL);
  });

  it('takes no arguments, so a model cannot name who is asking', () => {
    expect(AGENTS_TOOL.inputSchema.type).toBe('object');
    expect(AGENTS_TOOL.inputSchema.properties).toEqual({});
    expect(AGENTS_TOOL.inputSchema.required).toBeUndefined();
  });

  it('tells the model when to reach for it, not just what it does', () => {
    expect(AGENTS_TOOL.description.length).toBeGreaterThan(40);
    expect(AGENTS_TOOL.description).toMatch(/before/i);
  });

  /*
    The acceptance criterion "granted unconditionally, the way `mcp__hive__*`
    already is in waker.ts" — asserted rather than assumed, because it is the
    difference between a tool every agent can reach and one only an agent that
    happened to name it in `tools:` can. `waker.ts:214` (the `--allowedTools`
    grant) and `waker.ts:297` (`HOOK_ENV_GRANTS`, which the fence consults)
    both put this exact rule in front of it.
  */
  it('is covered by the wildcard every agent is granted, with no `tools:` entry', () => {
    expect(matches('mcp__hive__*', `mcp__hive__${AGENTS_TOOL.name}`, {})).toBe(true);
  });
});
