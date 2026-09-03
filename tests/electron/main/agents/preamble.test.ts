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

  /*
    The gap that stranded a real hand-off: `acr` was asked to review a PR by
    `pr-patrol`, reviewed it, and reported with `ledger_done`. A `done` carries
    no `to`, so `decide()` in `scheduler-rules.ts` discarded it as a broadcast
    and `pr-patrol` was never woken — it sat on `asking` with the verdict
    already posted to GitHub, until the 24-hour expiry told it, wrongly, that
    the review had never come back.

    The preamble was two-thirds of the cause. It taught read/ask/done/failed/
    handoff and **never mentioned `ledger_answer` at all**, while telling every
    agent unconditionally to "post one `ledger_done` per wake that did
    something". An agent following it literally can never close an ask made of
    it. These three assertions are the rule that was missing.
  */
  it('names ledger_answer as the way to close a peer ask', () => {
    expect(AGENT_PREAMBLE).toContain('ledger_answer');
    // `\s+`, not a literal space: the source is hard-wrapped prose and the
    // clause straddles a line break.
    expect(AGENT_PREAMBLE).toMatch(/never\s+`ledger_done`, and never both/i);
  });

  /*
    Stated as a shape test on the asker's id, not as "ask the directory who is
    an agent". `assertAgentName` reserves `overmind` and the `sess-` prefix
    (`guards.ts`, `isReservedAgentName`), so the id alone is a guaranteed
    discriminator — and one an agent can apply to what `ledger_read` already
    handed it, with no extra tool call to skip.
  */
  it('gives the person-or-agent test in terms of the asker id', () => {
    expect(AGENT_PREAMBLE).toContain('overmind');
    expect(AGENT_PREAMBLE).toContain('sess-');
  });

  it('stops ledger_done from claiming every wake that did something', () => {
    expect(AGENT_PREAMBLE).not.toContain(
      'Post one `ledger_done` per wake that did something, and',
    );
    expect(AGENT_PREAMBLE).toMatch(/did something nobody asked you for/);
  });

  it('tells the agent its own instructions are standing work', () => {
    expect(AGENT_PREAMBLE).toMatch(/instructions below/i);
    expect(AGENT_PREAMBLE).toMatch(/every wake/i);
  });
});
