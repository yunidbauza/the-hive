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
    ])('is a fixed point on its own output: %s', (title) => {
      const once = hiveNameFromTitle(title);
      expect(once).toBeDefined();
      expect(hiveNameFromTitle(once as string)).toBe(once);
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

    it('keeps a disambiguating suffix, because the pin is a whole prefix', () => {
      /*
        `ticketSessionName` spells a second session on one ticket `HIVE-73-2`.
        Parsing that back to a key would drop the `-2` and re-collide the two
        rows it exists to separate.
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
    it('leaves a title that is only a key exactly as it found it', () => {
      /**
       * The key is hoisted so it can stand in front of a description; with no
       * description there is nothing to hoist it in front of. Without this a
       * ledger entry for `sess-01` came back as `SESS-01` — a row shouting its
       * own id.
       */
      expect(hiveNameFromTitle('sess-01')).toBe('sess-01');
      expect(hiveNameFromTitle('HIVE-73')).toBe('HIVE-73');
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
