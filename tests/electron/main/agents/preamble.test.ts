import { describe, expect, it } from 'vitest';

import { AGENT_PREAMBLE } from '../../../../electron/main/agents/preamble';

describe('AGENT_PREAMBLE', () => {
  it('tells a woken agent to retry the denied call exactly once', () => {
    expect(AGENT_PREAMBLE).toMatch(/retry that one call exactly once/i);
    expect(AGENT_PREAMBLE).toMatch(/ledger_failed/);
  });

  it('tells the agent how to leave a handoff', () => {
    expect(AGENT_PREAMBLE).toContain('ledger_handoff');
    expect(AGENT_PREAMBLE).toContain('last turn on this session');
  });

  /*
    The sentence this replaces — "A wake where you found no work to do should
    end silently" — was written about *logging* and was read as being about
    *acting*. It sat directly under a heading about posting `ledger_done`, and
    an agent whose standing job lives in its body still read it as permission
    to end a quiet wake having done nothing at all.

    The rule it becomes says the same thing about the log and nothing about the
    work, so the two can no longer be confused.
  */
  it('makes silence a rule about the log, not about the work', () => {
    expect(AGENT_PREAMBLE).not.toContain('should end silently');
    expect(AGENT_PREAMBLE).toContain('Post nothing when there was nothing to');
  });

  it('tells the agent its own instructions are standing work', () => {
    expect(AGENT_PREAMBLE).toMatch(/instructions below/i);
    expect(AGENT_PREAMBLE).toMatch(/every wake/i);
  });
});
