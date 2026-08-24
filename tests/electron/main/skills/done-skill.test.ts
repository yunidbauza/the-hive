// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { doneCommand } from '../../../../electron/shared/hook-contract';
import { RESERVED_SKILL_NAME } from '../../../../electron/shared/skills-contract';

import { doneSkill } from '../../../../electron/main/skills/done-skill';

/**
 * The frontmatter's `key: value` lines, with the value exactly as emitted.
 *
 * Deliberately **not** `skills/read.ts`'s `frontmatter()`, which is a line
 * splitter rather than a parser and would report a file YAML rejects as fine —
 * which is precisely the bug these tests exist to catch.
 */
const frontmatterLines = (body: string): [string, string][] => {
  const block = body.split('---\n')[1] ?? '';
  return block
    .split('\n')
    .filter((line) => /^[a-z-]+:/i.test(line))
    .map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at), line.slice(at + 1).trim()];
    });
};

/**
 * One frontmatter value, read back **through** its quoting.
 *
 * A substring match on the raw body proves only that some bytes are present; it
 * cannot tell a value Claude Code will parse from one it will reject. Undoing
 * the single-quote form here is what makes the assertion about the value the
 * parser ends up with.
 */
const frontmatterValue = (body: string, key: string): string | undefined => {
  const found = frontmatterLines(body).find(([name]) => name === key);
  if (found === undefined) return undefined;
  const raw = found[1];
  return raw.startsWith("'") && raw.endsWith("'")
    ? raw.slice(1, -1).replaceAll("''", "'")
    : raw;
};

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

    it('emits frontmatter YAML can actually parse', () => {
      /*
        The regression this exists for shipped green under a `toContain` check.
        The rule contains `-H "x-hive-session: $HIVE_SESSION_ID"`, and a colon
        followed by a space is YAML's mapping-value indicator — forbidden inside
        a *plain* (unquoted) scalar however many double quotes appear later in
        it, because a scalar that does not start with a quote has no quoted
        regions at all. The scanner error kills the whole block, `name` and
        `description` with it, so `/done` is never registered — and since the
        built-in shares `skills/` with the user's own, it takes those down too.
      */
      for (const [key, raw] of frontmatterLines(body)) {
        if (raw.startsWith("'") || raw.startsWith('"')) continue;
        expect(
          raw,
          `plain scalar for "${key}" must not contain a colon-space`,
        ).not.toContain(': ');
      }
    });

    it('authorises exactly the command it runs, in its own frontmatter', () => {
      const command = doneCommand(DONE_URL);

      /*
        Read back **through** the quoting, so this asserts the value a parser
        ends up with rather than the bytes on the page. Both sides derive from
        one builder, which is what makes drift impossible rather than unlikely:
        if the grant and the command ever disagreed, the symptom would be a
        permission prompt in the middle of the app's own built-in.
      */
      expect(frontmatterValue(body, 'allowed-tools')).toBe(`Bash(${command})`);
      expect(body).toContain(command);
    });

    it('authorises the exact command, never a prefix', () => {
      /*
        `…:*` would let anything be appended to the same `curl` invocation, and
        `curl` has flags with nothing to do with the URL: `-K` reads a config
        that redefines the target, `-o`/`-D` write to a chosen path,
        `--upload-file` sends one. None need a shell operator, so none are
        caught by Claude Code's `&&`/`;` handling.
      */
      expect(frontmatterValue(body, 'allowed-tools')).not.toContain(':*');
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
