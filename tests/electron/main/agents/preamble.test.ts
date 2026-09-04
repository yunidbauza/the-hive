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
  it('names ledger_answer as the way to close an ask', () => {
    expect(AGENT_PREAMBLE).toContain('ledger_answer');
    // `\s+`, not a literal space: the source is hard-wrapped prose and the
    // clause straddles a line break.
    expect(AGENT_PREAMBLE).toMatch(/`ledger_answer`\s+is how you\s+close it/i);
  });

  /*
    The producer side of the card's presentation contract, and the only place
    an agent is told about it.

    `ask-card.tsx` and `notify.ts` both take an ask's first line as the title
    and the rest as the detail, with no fallback text of their own — that
    fallback used to exist, said "Send this reply?", and cost a drafting agent
    every word of its context. Removing it made this paragraph load-bearing:
    without it a wake writes one long paragraph and the rail sets the whole
    thing in semibold. A prompt edit that drops the rule would otherwise be
    silent, which is what every other assertion in this file exists to stop.
  */
  it('tells an agent its first line is the title, and to pass what it replies to', () => {
    expect(AGENT_PREAMBLE).toMatch(/first line\s+names the decision/i);
    expect(AGENT_PREAMBLE).toContain('inbound');
  });

  /*
    The rule is `overmind` versus everyone else, and NOT "a person versus an
    agent" — which is what this said first, and it was wrong in a way that
    reproduced the original bug one party over.

    A `sess-` party is a live terminal, and the only route into one is
    `deliver.ts`, whose `DELIVERABLE` is `['ask', 'answer']`. `scheduler.onEntry`
    returns early on `!isAgent(to)` and the expiry sweep wakes only
    `isAgent(ask.from)`, so a `done` addressed to a session reaches nothing at
    all — the session would wait forever, exactly as `pr-patrol` did. Only
    `overmind` reads a card, so only `overmind` takes a `done`.
  */
  it('sends every asker but the overmind to ledger_answer', () => {
    expect(AGENT_PREAMBLE).toMatch(/`overmind` is the one exception/i);
    expect(AGENT_PREAMBLE).toMatch(/another agent, or any id beginning `sess-`/i);
    expect(AGENT_PREAMBLE).toMatch(/takes\s+`ledger_answer`/i);
  });

  /*
    `toContain('overmind')` was the first version of the assertion above and
    proved nothing: the word already appears in the `ledger_ask` paragraph on
    `origin/main`, so half the test passed before the change existed. Asserted
    on the new sentences instead, each of which is absent from `main`.
  */
  it('stops ledger_done from claiming every wake that did something', () => {
    expect(AGENT_PREAMBLE).not.toContain(
      'Post one `ledger_done` per wake that did something, and',
    );
    expect(AGENT_PREAMBLE).toMatch(/at most one `ledger_done` per wake/i);
  });

  it('tells the agent its own instructions are standing work', () => {
    expect(AGENT_PREAMBLE).toMatch(/instructions below/i);
    expect(AGENT_PREAMBLE).toMatch(/every wake/i);
  });
});
