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
});
