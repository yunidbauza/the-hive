import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  noteSessionPr,
  noteSessionTicket,
  readSessionHistory,
} from '@lib/session-history';

/**
 * The renderer's half of the ledger (HIVE-87).
 *
 * Every case here is about *not* making a fuss. This module reads a
 * convenience, not a source of truth: no bridge, a failed channel and an empty
 * file all mean the same thing on screen — the state a first launch is in — and
 * none of them may reach the user as an error or stop the app booting.
 */
describe('session history', () => {
  const original = window.hive;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete window.hive;
    else window.hive = original;
    vi.restoreAllMocks();
  });

  const bridgeWith = (session: Record<string, unknown>) => {
    window.hive = { session } as unknown as NonNullable<Window['hive']>;
  };

  describe('readSessionHistory', () => {
    it('returns what main answered', async () => {
      const records = [
        { id: 'sess-01', project: 'p', task: '', status: 'done', createdAt: 1 },
      ];
      bridgeWith({ history: vi.fn(() => Promise.resolve(records)) });

      await expect(readSessionHistory()).resolves.toEqual(records);
    });

    it('returns nothing in the browser demo, where there is no bridge', async () => {
      // Feature-detect the bridge, never the user agent (story 083).
      delete window.hive;

      await expect(readSessionHistory()).resolves.toEqual([]);
    });

    it('returns nothing when the channel itself fails', async () => {
      // Main never rejects this read, so a rejection is a broken hop — not
      // something the user can fix, and not worth degrading the app over.
      bridgeWith({ history: vi.fn(() => Promise.reject(new Error('gone'))) });

      await expect(readSessionHistory()).resolves.toEqual([]);
    });

    it('never throws at a caller that does not await it', async () => {
      bridgeWith({ history: vi.fn(() => Promise.reject(new Error('gone'))) });

      await expect(readSessionHistory()).resolves.not.toThrow();
    });
  });

  describe('noteSessionTicket', () => {
    it('hands the confirmed key to main', () => {
      const note = vi.fn(() => Promise.resolve());
      bridgeWith({ note });

      noteSessionTicket({ entityId: 'sess-01', ticket: 'HIVE-87' });

      expect(note).toHaveBeenCalledWith({
        entityId: 'sess-01',
        ticket: 'HIVE-87',
      });
    });

    it('does nothing at all without a bridge', () => {
      delete window.hive;

      expect(() =>
        noteSessionTicket({ entityId: 'sess-01', ticket: 'HIVE-87' }),
      ).not.toThrow();
    });

    it('swallows a rejection rather than surfacing an unhandled one', async () => {
      // Fire and forget: a failure costs a ticket link in next launch's
      // history and nothing in this one.
      bridgeWith({ note: vi.fn(() => Promise.reject(new Error('nope'))) });

      expect(() =>
        noteSessionTicket({ entityId: 'sess-01', ticket: 'HIVE-87' }),
      ).not.toThrow();
      await Promise.resolve();
    });
  });

  /**
   * The second fact main cannot author, and the renderer's for a different
   * reason from the ticket's: main does not sweep GitHub.
   */
  describe('noteSessionPr', () => {
    const request = {
      entityId: 'sess-01',
      pr: {
        number: 118,
        repo: 'nova-web',
        url: 'https://github.com/demo/nova-web/pull/118',
      },
    };

    it('hands the resolved pull request to main', () => {
      const pr = vi.fn(() => Promise.resolve());
      bridgeWith({ pr });

      noteSessionPr(request);

      expect(pr).toHaveBeenCalledWith(request);
    });

    it('does nothing at all without a bridge', () => {
      delete window.hive;

      expect(() => noteSessionPr(request)).not.toThrow();
    });

    it('swallows a rejection rather than surfacing an unhandled one', async () => {
      // A failure costs a `#123` in next launch's fleet table and nothing here.
      bridgeWith({ pr: vi.fn(() => Promise.reject(new Error('nope'))) });

      expect(() => noteSessionPr(request)).not.toThrow();
      await Promise.resolve();
    });
  });
});
