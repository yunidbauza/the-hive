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

    it('authorises exactly the command it runs, in its own frontmatter', () => {
      const command = doneCommand(DONE_URL);

      /*
        Both derived from one builder, which is what makes drift impossible
        rather than unlikely. If the grant and the command ever disagreed the
        symptom would be a permission prompt in the middle of the app's own
        built-in — something the user did not cause and cannot diagnose.
      */
      expect(body).toContain(`allowed-tools: Bash(${command})`);
      expect(body).toContain(command);
    });

    it('grants the tool at the skill, not in the app-wide settings file', () => {
      /*
        The settings file merges above the user's own scope, so a grant written
        there is invisible and unrevokable to them. `allowed-tools` is scoped to
        the one skill that needs it. See `hooks/settings.test.ts` for the other
        half of this pair.
      */
      expect(
        hookSettings('http://127.0.0.1:51234/hook', 'dark'),
      ).not.toHaveProperty('permissions');
    });

    it('authorises the exact command, never a prefix', () => {
      /*
        `…:*` would let anything be appended to the same `curl` invocation, and
        `curl` has flags with nothing to do with the URL: `-K` reads a config
        that redefines the target, `-o`/`-D` write to a chosen path,
        `--upload-file` sends one. None need a shell operator, so none are
        caught by Claude Code's `&&`/`;` handling.
      */
      expect(body).not.toContain(':*)');
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
