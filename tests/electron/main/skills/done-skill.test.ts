// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { doneCommand } from '../../../../electron/shared/hook-contract';
import { RESERVED_SKILL_NAME } from '../../../../electron/shared/skills-contract';

import { hookSettings } from '../../../../electron/main/hooks/settings';
import { doneSkill } from '../../../../electron/main/skills/done-skill';

/**
 * The generated `/done` (HIVE-93).
 *
 * Two of the assertions here are guards against regressions that would be
 * invisible in the app and expensive to diagnose:
 *
 * - **the frontmatter flag.** `disable-model-invocation: true` shipped with the
 *   inert version and is enforced by Claude Code as "user-invocable only". With
 *   it set, a skill cannot hand off to `/done` *and is told not to work around
 *   it* — which silently removes half of what this exists for, with no error
 *   anywhere.
 * - **the command.** The body and the permission in the settings file are two
 *   copies of one string. If they drift, the app's own built-in stops on a
 *   permission prompt the user did not cause and cannot read.
 */
describe('doneSkill', () => {
  const DONE_URL = 'http://127.0.0.1:51234/done';

  describe('with a receiver to report to', () => {
    const body = doneSkill(DONE_URL);

    it('is the reserved name, so the plugin writes it where /done resolves', () => {
      expect(body).toContain(`name: ${RESERVED_SKILL_NAME}`);
    });

    it('runs exactly the command the settings file permits', () => {
      const command = doneCommand(DONE_URL);
      expect(body).toContain(command);

      const rule = hookSettings(
        'http://127.0.0.1:51234/hook',
        'dark',
        DONE_URL,
      ).permissions!.allow[0]!;
      // Exact, not a prefix — see the settings test for why that matters.
      expect(rule).toBe(`Bash(${command})`);
    });

    it('is invocable by a skill handing off, not only by a user typing it', () => {
      /*
        The regression guard. Claude Code refuses a `Skill` tool call for a
        skill carrying this flag — "reserved for explicit user invocation" — so
        its presence would break handoff without breaking anything visible.
      */
      expect(body).not.toContain('disable-model-invocation');
    });

    it('tells the agent the app owns the closing, so it does not try', () => {
      // No tool can end an interactive session; an agent that believes
      // otherwise burns a turn discovering it.
      expect(body).toContain('you cannot close it yourself');
    });

    it('asks for no summary', () => {
      expect(body).toContain('Do not summarise');
    });
  });

  describe('with no receiver', () => {
    const body = doneSkill(null);

    it('promises nothing it cannot do', () => {
      expect(body).not.toContain('curl');
      expect(body).toContain('cannot be closed automatically');
    });

    it('still carries the reserved name, so /done exists and explains itself', () => {
      /*
        A missing skill and an honest one read very differently at the prompt:
        `/done` absent looks like a broken install, `/done` explaining that the
        app is unreachable is a fact the user can act on.
      */
      expect(body).toContain(`name: ${RESERVED_SKILL_NAME}`);
    });
  });
});
