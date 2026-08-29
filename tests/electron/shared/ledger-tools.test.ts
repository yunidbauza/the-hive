import { describe, expect, it } from 'vitest';

import { LEDGER_KINDS } from '@shared/ledger-contract';
import { LEDGER_TOOLS, LEDGER_TOOL_NAMES } from '@shared/ledger-tools';

describe('ledger-tools', () => {
  it('ships exactly the eight tools the epic names', () => {
    expect(LEDGER_TOOL_NAMES).toEqual([
      'ledger_read',
      'ledger_post',
      'ledger_ask',
      'ledger_answer',
      'ledger_claim',
      'ledger_release',
      'ledger_done',
      'ledger_failed',
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
    for (const kind of ['post', 'ask', 'answer', 'claim', 'release', 'done', 'failed']) {
      expect(LEDGER_KINDS).toContain(kind);
    }
  });
});
