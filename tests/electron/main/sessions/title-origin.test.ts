import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeProjectDir,
  createTitleOriginReader,
} from '../../../../electron/main/sessions/title-origin';

/**
 * Telling a `/rename` apart from Claude's own auto-title (first-prompt naming).
 *
 * Real files rather than a mocked `fs`, because every interesting case here is a
 * property of a file — a tail that starts mid-line, a transcript that does not
 * exist yet, a line that is not JSON. A mock would be asserting that the code
 * calls `readSync`, which is not the thing that has to be true.
 */
describe('title origin', () => {
  let home: string;

  const cwd = '/Users/someone/Projects/the-hive';
  const uuid = '566e7d27-27db-402d-b6e3-e512368bd770';

  /** Write a transcript for {@link cwd}/{@link uuid} made of these raw lines. */
  function writeTranscript(lines: string[]): void {
    const dir = join(home, '.claude', 'projects', claudeProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.jsonl`), `${lines.join('\n')}\n`);
  }

  const turn = (text: string): string =>
    JSON.stringify({ type: 'assistant', content: text, sessionId: uuid });

  const aiTitle = (title: string): string =>
    JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: uuid });

  const customTitle = (title: string): string =>
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: uuid });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hive-title-origin-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('the directory name', () => {
    it('replaces every non-alphanumeric character with a dash', () => {
      expect(claudeProjectDir('/Users/me/Projects/the-hive')).toBe('-Users-me-Projects-the-hive');
    });

    it('collapses a dot into the separator, doubling the dash', () => {
      // Measured against the real directories on disk: a hidden folder in the
      // path is why `-Users-me--claude-jobs-x` has two dashes in the middle.
      expect(claudeProjectDir('/Users/me/.claude/jobs/x')).toBe('-Users-me--claude-jobs-x');
    });
  });

  describe('classifying a title', () => {
    it('reads a `custom-title` as a rename', () => {
      writeTranscript([turn('hello'), customTitle('HIVE-123')]);

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('rename');
    });

    it("reads an `ai-title` as the agent's own guess", () => {
      writeTranscript([turn('hello'), aiTitle('PR 157 merge check and implementation')]);

      expect(
        createTitleOriginReader({ home }).classify(
          cwd,
          uuid,
          'PR 157 merge check and implementation',
        ),
      ).toBe('agent');
    });

    it('matches by value, not by which record was written last', () => {
      /*
        The question is "what wrote *this* name", not "what is this session
        called". A session that was renamed after Claude had already titled it
        holds both records, and each name must still classify as its own writer —
        otherwise a repaint of the older title would be read as a rename.
      */
      writeTranscript([aiTitle('github token debug'), customTitle('HIVE-123')]);

      const reader = createTitleOriginReader({ home });
      expect(reader.classify(cwd, uuid, 'HIVE-123')).toBe('rename');
      expect(reader.classify(cwd, uuid, 'github token debug')).toBe('agent');
    });

    it('answers unknown for a name no record carries', () => {
      // The repaint that beats the transcript append. Reported as unknown so the
      // caller declines to cache it and asks again a frame later.
      writeTranscript([turn('hello'), aiTitle('something else')]);

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('unknown');
    });

    it('finds a record that is not the last line', () => {
      writeTranscript([aiTitle('header pill rendering delay'), turn('a'), turn('b'), turn('c')]);

      expect(
        createTitleOriginReader({ home }).classify(cwd, uuid, 'header pill rendering delay'),
      ).toBe('agent');
    });
  });

  describe('what it refuses to fall over on', () => {
    it('answers unknown when the transcript does not exist', () => {
      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('unknown');
    });

    it('finds the transcript even when the directory name does not match the cwd', () => {
      /*
        `claudeProjectDir` is this repo's reconstruction of someone else's
        encoding, and a path that is not the path it says defeats it — on macOS
        `/var/folders/x` really lives at `/private/var/folders/x`, and Claude
        records whichever spelling its own process resolved. A miss would report
        `unknown`, which reads as "Claude's guess", so a `/rename` would be
        silently dropped for any session whose path contains a symlink.
      */
      writeTranscript([customTitle('HIVE-123')]);

      expect(
        createTitleOriginReader({ home }).classify('/a/completely/different/path', uuid, 'HIVE-123'),
      ).toBe('rename');
    });

    it('answers unknown when no project directory holds that conversation', () => {
      expect(
        createTitleOriginReader({ home }).classify('/nowhere/at/all', uuid, 'HIVE-123'),
      ).toBe('unknown');
    });

    it('answers unknown for an empty transcript', () => {
      const dir = join(home, '.claude', 'projects', claudeProjectDir(cwd));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${uuid}.jsonl`), '');

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('unknown');
    });

    it('steps over a line that is not JSON', () => {
      // A title record written while the previous line was still being flushed.
      writeTranscript(['{"type":"ai-title", not json at all', customTitle('HIVE-123')]);

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('rename');
    });

    it('steps over a title record whose payload is the wrong shape', () => {
      writeTranscript([
        JSON.stringify({ type: 'custom-title', customTitle: 42 }),
        customTitle('HIVE-123'),
      ]);

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('rename');
    });

    it('does not mistake a turn that merely mentions a title record', () => {
      // An assistant turn quoting `"ai-title"` passes the cheap substring test
      // and must still fail the parse-and-check that follows it.
      writeTranscript([turn('the "ai-title" record is written once'), customTitle('HIVE-123')]);

      expect(createTitleOriginReader({ home }).classify(cwd, uuid, 'HIVE-123')).toBe('rename');
    });
  });

  describe('the bounded tail', () => {
    it('drops the partial first line rather than parsing half a record', () => {
      /*
        A tail that does not start at byte 0 begins mid-line by construction. The
        record being looked for is at the end — which is where it always is at
        the only moment anyone asks, because it was just appended.
      */
      const filler = Array.from({ length: 200 }, (_, i) => turn(`turn ${i} ${'x'.repeat(200)}`));
      writeTranscript([...filler, customTitle('HIVE-123')]);

      expect(
        createTitleOriginReader({ home, tailBytes: 2_048 }).classify(cwd, uuid, 'HIVE-123'),
      ).toBe('rename');
    });

    it('cannot see a record that falls outside the tail', () => {
      // The honest limit, asserted rather than left to be discovered: this is
      // why the caller only asks at the instant a title changed.
      const filler = Array.from({ length: 200 }, (_, i) => turn(`turn ${i} ${'x'.repeat(200)}`));
      writeTranscript([aiTitle('an old title'), ...filler]);

      expect(
        createTitleOriginReader({ home, tailBytes: 2_048 }).classify(cwd, uuid, 'an old title'),
      ).toBe('unknown');
    });
  });
});
