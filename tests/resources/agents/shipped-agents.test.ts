// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseAgent } from '../../../electron/main/agents/definition';

/**
 * Every agent the app ships parses against the skills the app ships
 * (HIVE-168). The seeder copies these into `~/.hive/agents` verbatim, and a
 * definition the registry refuses is listed with its problem and never wakes,
 * which would be a shipped agent that does nothing on a fresh machine.
 */
const resources = fileURLToPath(new URL('../../../resources', import.meta.url));
const shippedSkills = readdirSync(join(resources, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const shippedAgents = readdirSync(join(resources, 'agents'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('shipped agents', () => {
  it('ships shipper and acr', () => {
    expect(shippedAgents.sort()).toEqual(['acr', 'shipper']);
  });

  it.each(shippedAgents)('%s parses against the shipped skills', (name) => {
    const source = readFileSync(join(resources, 'agents', name, 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: name,
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    expect('problems' in result ? result.problems : []).toEqual([]);
    if ('def' in result) expect(result.def.name).toBe(name);
  });

  it('never grants the shipper the merge call: the fence and the auto-merge grant own it', () => {
    const source = readFileSync(join(resources, 'agents', 'shipper', 'AGENT.md'), 'utf8');
    expect(source).not.toMatch(/Bash\(gh pr merge/);
    expect(source).not.toMatch(/Bash\(gh pr \*\)/);
    expect(source).not.toMatch(/\bBash\b(?!\()/);
  });
});
