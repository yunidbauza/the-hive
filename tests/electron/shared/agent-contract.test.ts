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
} from '../../../electron/shared/agent-contract';
import { OVERMIND } from '../../../electron/shared/ledger-contract';
import { RESERVED_SKILL_NAME } from '../../../electron/shared/skills-contract';

describe('agent-contract', () => {
  it('derives reserved names from the constants that own them', () => {
    // Spelling 'overmind'/'done' here would leave two copies to keep in step.
    expect(RESERVED_AGENT_NAMES).toContain(OVERMIND);
    expect(RESERVED_AGENT_NAMES).toContain(RESERVED_SKILL_NAME);
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

  it('defaults limits to 40 turns, $0.50 and 50 runs', () => {
    expect(AGENT_LIMIT_DEFAULTS).toEqual({
      turns: 40,
      budgetUsd: 0.5,
      rotateAfter: 50,
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
