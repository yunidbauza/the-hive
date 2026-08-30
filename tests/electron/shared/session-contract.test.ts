import { describe, expect, it } from 'vitest';

import {
  hiveNameFromTitle,
  isSendableSessionName,
  SESSION_NAME_MAX,
} from '../../../electron/shared/session-contract';

/**
 * The normaliser that turns an agent's terminal title into a rail name
 * (HIVE-108).
 *
 * This is the whole of the naming feature that can be tested without a real
 * `claude`. What it cannot show — that Claude produces a title at all once
 * `--name` is dropped — is what `tests/live/title-conformance.test.ts` exists
 * for, and the two together are the claim.
 */
describe('hiveNameFromTitle', () => {
  describe('the shape', () => {
    it('hyphenates and case-folds a plain title', () => {
      // What a real `claude` produced, measured: capitalised, two words.
      expect(hiveNameFromTitle('Mutex explanation')).toBe('mutex-explanation');
    });

    it('keeps a four-word title whole', () => {
      expect(hiveNameFromTitle('remove jira fixtures loader')).toBe(
        'remove-jira-fixtures-loader',
      );
    });

    it('hoists a ticket key to the front and upper-cases it', () => {
      /**
       * The key is the first thing the eye needs and Claude puts it wherever the
       * sentence ended, so leaving it in place would make a column of these
       * unscannable.
       */
      expect(hiveNameFromTitle('back key interception hive-53')).toBe(
        'HIVE-53-back-key-interception',
      );
    });

    it('does not spend the word budget on the key', () => {
      // Key plus four words, not three: the key is identity, not description.
      expect(hiveNameFromTitle('epic hive-3 completion of the rail work')).toBe(
        'HIVE-3-epic-completion-of-the',
      );
    });

    it('truncates a long title by dropping words, never mid-word', () => {
      const name = hiveNameFromTitle('one two three four five six seven');
      expect(name).toBe('one-two-three-four');
    });
  });

  describe('idempotence', () => {
    /**
     * The property everything else rests on. Claude repaints its title several
     * times a second and every repaint runs through here, so a function that
     * grew its own output would rename the session on every frame.
     */
    it.each([
      'Mutex explanation',
      'remove jira fixtures loader',
      'back key interception hive-53',
      'fix the login bug',
      'one two three four five six seven',
      /*
        The four below are regressions, not hypotheticals. With the key matched
        by `\b…\b` rather than against a whole word, the hyphen this function
        *inserts* was read back as a key boundary on the second pass:

          'Fix bug 123'      -> 'fix-bug-123'      -> 'BUG-123-fix'
          'React 18 upgrade' -> 'react-18-upgrade' -> 'REACT-18-upgrade'

        The path is real: a restart re-asserts the stored name as `--name`,
        Claude paints it as its title, and it returns through `renameSession` —
        so a restarted session silently renamed and reordered itself.
      */
      'Fix bug 123',
      'React 18 upgrade',
      'chapter 3 review',
      'typescript-5 upgrade',
    ])('is a fixed point on its own output: %s', (title) => {
      const once = hiveNameFromTitle(title);
      expect(once).toBeDefined();
      expect(hiveNameFromTitle(once as string)).toBe(once);
    });

    it('does not read its own separator as a ticket key', () => {
      // The specific shape of the regression: a bare number after a word.
      expect(hiveNameFromTitle('Fix bug 123')).toBe('fix-bug-123');
      expect(hiveNameFromTitle('fix-bug-123')).toBe('fix-bug-123');
    });

    it('is a fixed point under a pin too', () => {
      const once = hiveNameFromTitle('back key interception', 'HIVE-73');
      expect(once).toBe('HIVE-73-back-key-interception');
      expect(hiveNameFromTitle(once as string, 'HIVE-73')).toBe(once);
    });
  });

  describe('the pin', () => {
    it('puts the pinned key in front of what the agent inferred', () => {
      expect(hiveNameFromTitle('Mutex explanation', 'HIVE-73')).toBe(
        'HIVE-73-mutex-explanation',
      );
    });

    it('outranks a different key the title happens to mention', () => {
      /**
       * A session routinely *discusses* another ticket. The pin is the user's
       * own statement about which issue this session is for, and the title is a
       * guess made from the conversation.
       */
      expect(hiveNameFromTitle('fixing hive-99 regression', 'HIVE-73')).toBe(
        'HIVE-73-fixing-regression',
      );
    });

    it('uses the prefix verbatim, whatever shape it is', () => {
      /*
        The function does not parse the pin, so a caller may pin `HIVE-73-2` and
        get exactly that in front. The store does not pass that shape — it passes
        `ticket`, and `renameSession` says why — but the contract here is
        "verbatim", and pinning that on a test is what stops a future caller
        being surprised.
      */
      expect(hiveNameFromTitle('Mutex explanation', 'HIVE-73-2')).toBe(
        'HIVE-73-2-mutex-explanation',
      );
    });

    it('answers with the pin alone when the title carries no words', () => {
      expect(hiveNameFromTitle('HIVE-73', 'HIVE-73')).toBe('HIVE-73');
    });
  });

  describe('what it refuses to restyle', () => {
    it('leaves a name already in the register exactly as it found it', () => {
      /**
       * A hyphenated single token that a command line would accept is one of
       * ours, or a slug a user typed. Re-deriving it is what broke idempotence:
       * a second pass cannot tell the hyphens this function inserted from the
       * ones that were always there. Without it a session-history entry for
       * `sess-01` also came back as `SESS-01` — a row shouting its own id.
       */
      expect(hiveNameFromTitle('sess-01')).toBe('sess-01');
      expect(hiveNameFromTitle('HIVE-73')).toBe('HIVE-73');
      expect(hiveNameFromTitle('troubleshooting-crawling')).toBe(
        'troubleshooting-crawling',
      );
    });

    it('still case-folds a bare word, which is idempotent on its own', () => {
      // Not a passthrough: the passthrough needs a hyphen, so a one-word title
      // is not left shouting a capital among a column of lower-case names.
      expect(hiveNameFromTitle('Debugging')).toBe('debugging');
      expect(hiveNameFromTitle('debugging')).toBe('debugging');
    });

    it('reads a key through surrounding punctuation, and answers a real name', () => {
      /*
        The earlier draft returned the raw title whenever no words survived, so
        `(hive-53)` became a name with parentheses in it — not in the rail's
        register, and not sendable, so a later restart silently dropped it.
      */
      expect(hiveNameFromTitle('(hive-53)')).toBe('HIVE-53');
      expect(hiveNameFromTitle('[HIVE-53]')).toBe('HIVE-53');
    });

    it('answers undefined for a title with nothing nameable in it', () => {
      expect(hiveNameFromTitle('')).toBeUndefined();
      expect(hiveNameFromTitle('   ')).toBeUndefined();
      expect(hiveNameFromTitle('!!! ???')).toBeUndefined();
    });

    it('does not read a date as a ticket key', () => {
      // The first character of a key must be a letter, which is what keeps
      // `2026-08-27` out — it stays where it was written rather than being
      // upper-cased and hoisted to the front.
      expect(hiveNameFromTitle('2026-08-27 retro')).toBe('2026-08-27-retro');
    });
  });

  describe('the boundary with what may be sent', () => {
    it('produces names the command line would accept', () => {
      /*
        Not required — these are only ever rendered — but it is the property
        that lets a restart re-assert an inferred name, which `session-control`
        filters through `isSendableSessionName`.
      */
      for (const title of [
        'Mutex explanation',
        'back key interception hive-53',
        'fix "login" & logout',
      ]) {
        const name = hiveNameFromTitle(title);
        expect(name).toBeDefined();
        expect(isSendableSessionName(name as string)).toBe(true);
      }
    });

    it('never exceeds the sendable length', () => {
      const long = hiveNameFromTitle(
        'extraordinarily circumlocutory nomenclature generation subsystem',
      );
      expect(long).toBeDefined();
      expect((long as string).length).toBeLessThanOrEqual(SESSION_NAME_MAX);
    });
  });
});
