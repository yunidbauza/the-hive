// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AGENT_FIELDS,
  AGENT_LIMIT_DEFAULTS,
  AGENT_NAME_PATTERN,
  AGENT_PARENT_KEYS,
  KNOWN_AGENT_MCP,
  RESERVED_AGENT_NAMES,
  WAKE_EVERY_FLOOR_MS,
  WAKE_ON_EVENTS,
  formatRunCost,
  isReservedAgentName,
  isWakeOn,
} from '../../../electron/shared/agent-contract';
import { OVERMIND } from '../../../electron/shared/ledger-contract';
import { RESERVED_SKILL_NAME } from '../../../electron/shared/skills-contract';

describe('agent-contract', () => {
  it('derives reserved names from the constants that own them', () => {
    // Spelling 'overmind'/'done' here would leave two copies to keep in step.
    expect(RESERVED_AGENT_NAMES).toContain(OVERMIND);
    expect(RESERVED_AGENT_NAMES).toContain(RESERVED_SKILL_NAME);
  });

  /**
   * The one register `RESERVED_AGENT_NAMES` cannot hold (HIVE-115).
   *
   * There is no list of session ids to enumerate — `nextSessionId` mints them
   * on demand — so the reservation is a shape, and `isReservedAgentName` is what
   * puts the two questions back together for the four places that validate a
   * name: the IPC guard, the definition parser, the registry's listing filter
   * and the Settings form.
   */
  it('reserves the session-id shape as well as the named identities', () => {
    expect(isReservedAgentName(OVERMIND)).toBe(true);
    expect(isReservedAgentName(RESERVED_SKILL_NAME)).toBe(true);
    expect(isReservedAgentName('sess-01')).toBe(true);
    expect(isReservedAgentName('sess-zz')).toBe(true);

    expect(isReservedAgentName('slack-watcher')).toBe(false);
    // The prefix is reserved at the start, not wherever it appears.
    expect(isReservedAgentName('assess-risk')).toBe(false);
  });

  it('reserves exactly what hive-store mints', () => {
    // `nextSessionId` formats base 36, padded to two: sess-01 … sess-zz and on.
    for (let n = 1; n <= 100; n += 1) {
      expect(
        isReservedAgentName(`sess-${n.toString(36).padStart(2, '0')}`),
      ).toBe(true);
    }
  });

  it('accepts kebab names and rejects anything else', () => {
    expect(AGENT_NAME_PATTERN.test('slack-watcher')).toBe(true);
    expect(AGENT_NAME_PATTERN.test('Slack_Watcher')).toBe(false);
  });

  it('floors the wake interval at one minute', () => {
    expect(WAKE_EVERY_FLOOR_MS).toBe(60_000);
  });

  it('names slack as the only known integration for now', () => {
    expect(KNOWN_AGENT_MCP).toEqual(['slack']);
  });

  /*
    Two defaults, not three. A budget has none on purpose: a cap is unlimited
    unless the author sets one, and any number safe enough to impose is small
    enough to cut off ordinary wakes — the binary prices a run at list rates
    whether or not a subscription is billed for it.
  */
  it('defaults limits to 40 turns and 50 runs, and no budget', () => {
    expect(AGENT_LIMIT_DEFAULTS).toEqual({
      turns: 40,
      rotateAfter: 50,
    });
    expect(AGENT_LIMIT_DEFAULTS).not.toHaveProperty('budgetUsd');
  });

  /*
    `wake.on` was the one list in the grammar `parseAgent` never checked — it
    cast the parsed strings straight to `WakeOn`, so a typo saved cleanly and
    then silently never fired. This is the rule that closed it.
  */
  describe('isWakeOn', () => {
    it('takes the two fixed events', () => {
      for (const event of WAKE_ON_EVENTS) expect(isWakeOn(event)).toBe(true);
    });

    it('takes a channel, with or without its hash', () => {
      expect(isWakeOn('slack.channel:#incorp-dev')).toBe(true);
      expect(isWakeOn('slack.channel:incorp-dev')).toBe(true);
      expect(isWakeOn('slack.channel:build_alerts.v2')).toBe(true);
    });

    it('refuses a word that is not an event', () => {
      expect(isWakeOn('bananna')).toBe(false);
      expect(isWakeOn('')).toBe(false);
      expect(isWakeOn('slack')).toBe(false);
    });

    it('refuses a channel with nothing, or nonsense, after the colon', () => {
      expect(isWakeOn('slack.channel:')).toBe(false);
      expect(isWakeOn('slack.channel:#')).toBe(false);
      expect(isWakeOn('slack.channel:two words')).toBe(false);
      expect(isWakeOn('slack.channel:#Shouty')).toBe(false);
    });
  });

  it('declares every field the example file uses, and no duplicates', () => {
    const paths = AGENT_FIELDS.map((field) => field.path);

    expect(paths).toEqual([
      'name',
      'description',
      'icon',
      'model',
      'effort',
      'wake.every',
      'wake.at',
      'wake.days',
      'wake.on',
      'wake.quiet',
      'skills',
      'mcp',
      'tools',
      'autonomy',
      'limits.turns',
      'limits.budget_usd',
      'limits.rotate_after',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('marks exactly name, description and icon required', () => {
    const required = AGENT_FIELDS.filter((field) => field.required).map(
      (field) => field.path,
    );

    expect(required).toEqual(['name', 'description', 'icon']);
  });

  it('gives every enum field its allowed values', () => {
    for (const field of AGENT_FIELDS) {
      if (field.kind !== 'enum') continue;

      expect(field.values, `${field.path} has no values`).toBeDefined();
      expect(field.values?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('derives the nesting parents from the table', () => {
    expect(AGENT_PARENT_KEYS).toEqual(['wake', 'limits']);
  });
});

/** HIVE-115. One formatter, so the list and the live push cannot disagree. */
describe('formatRunCost', () => {
  it('gives an ordinary run two decimals', () => {
    expect(formatRunCost(1.5)).toBe('$1.50');
    expect(formatRunCost(0.42)).toBe('$0.42');
  });

  it('gives a sub-cent run four, rather than reporting $0.00', () => {
    expect(formatRunCost(0.0023)).toBe('$0.0023');
    expect(formatRunCost(0.00001)).toBe('$0.0000');
  });

  it('says nothing when there is no number to say it about', () => {
    // A run killed before its `result` records no cost, and a row that showed
    // `$0.00` for it would be claiming the run was free rather than unmeasured.
    expect(formatRunCost(undefined)).toBeUndefined();
    expect(formatRunCost(Number.NaN)).toBeUndefined();
    expect(formatRunCost(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
