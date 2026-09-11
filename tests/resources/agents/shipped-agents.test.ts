// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseAgent } from '../../../electron/main/agents/definition';
import { AGENT_ICON_NAMES } from '@features/settings/components/agent-form';
import { matches } from '../../../electron/shared/permission-rules';

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
  it('ships shipper, acr, fixer and builder', () => {
    expect(shippedAgents.sort()).toEqual(['acr', 'builder', 'fixer', 'shipper']);
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
    if ('def' in result) {
      expect(result.def.name).toBe(name);
      // An icon the Settings list does not know draws as a question mark.
      expect(AGENT_ICON_NAMES).toContain(result.def.icon);
    }
  });

  it('never grants the shipper a merge, by gh pr merge, by REST or by a GraphQL mutation', () => {
    const source = readFileSync(join(resources, 'agents', 'shipper', 'AGENT.md'), 'utf8');
    const result = parseAgent(source, {
      folder: 'shipper',
      skillNames: shippedSkills,
      hiveSkillNames: shippedSkills,
      integrations: ['slack'],
    });
    if (!('def' in result)) throw new Error('shipper does not parse');
    const allows = (command: string) =>
      result.def.tools.some((rule) => matches(rule, 'Bash', { command }));

    // The real fence, over the real rules: the grammar is what says no.
    expect(allows('gh pr merge 1 --squash --repo o/r')).toBe(false);
    expect(allows('gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash')).toBe(false);
    expect(allows("gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'")).toBe(false);
    // What the stage table does run.
    expect(allows('gh pr view 1 --repo o/r --json state,headRefOid')).toBe(true);
    expect(allows('gh pr checks 1 --repo o/r')).toBe(true);
    expect(allows('git -C /w merge --ff-only origin/feat')).toBe(true);
    expect(allows('gh workflow list --repo o/r --json name,path,state')).toBe(true);
  });
});
