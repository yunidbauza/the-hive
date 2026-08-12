import { describe, expect, it } from 'vitest';

import { containsPath, relativeRoot } from '@lib/explorer/session-root';

/**
 * Where the explorer roots for a session that moved (HIVE-78).
 *
 * The refusal cases are the important ones. `electron/main/fs/paths.ts` is the
 * explorer's security boundary and this does not widen it — a cwd outside the
 * mapped project resolves to `''`, so the panel asks for something the guard
 * would allow rather than something it would refuse.
 */
describe('containsPath', () => {
  it('accepts the root itself and anything under it', () => {
    expect(containsPath('/w/app', '/w/app')).toBe(true);
    expect(containsPath('/w/app', '/w/app/src')).toBe(true);
    expect(containsPath('/w/app', '/w/app/.claude/worktrees/x')).toBe(true);
  });

  it('refuses a sibling that merely shares the prefix', () => {
    /**
     * The classic prefix bug, and the reason main's `contains()` calls its
     * trailing separator load-bearing. It looks fine until someone has two
     * sibling repositories.
     */
    expect(containsPath('/w/app', '/w/app-secrets')).toBe(false);
  });

  it('refuses an unrelated path', () => {
    expect(containsPath('/w/app', '/etc/passwd')).toBe(false);
    expect(containsPath('/w/app', '/w')).toBe(false);
  });
});

describe('relativeRoot', () => {
  it('answers the worktree prefix — the case this exists for', () => {
    expect(
      relativeRoot('/w/app', '/w/app/.claude/worktrees/incorp-332'),
    ).toBe('.claude/worktrees/incorp-332');
  });

  it('answers the empty root for an ordinary session', () => {
    // The overwhelmingly common case: the agent never left the project.
    expect(relativeRoot('/w/app', '/w/app')).toBe('');
  });

  it('tolerates a trailing separator on either side', () => {
    expect(relativeRoot('/w/app/', '/w/app/src')).toBe('src');
    expect(relativeRoot('/w/app', '/w/app/src/')).toBe('src');
    expect(relativeRoot('/w/app/', '/w/app/')).toBe('');
  });

  describe('does not retarget', () => {
    it('when the cwd is outside the mapped project', () => {
      /**
       * A worktree the user keeps in `~/worktrees` is real and common, and the
       * fs guard would refuse every read under it. Answering `''` shows the
       * project root — something true — instead of an error about a path the
       * panel should not have asked for.
       */
      expect(relativeRoot('/w/app', '/home/me/worktrees/thing')).toBe('');
    });

    it('when the cwd is a sibling sharing the prefix', () => {
      expect(relativeRoot('/w/app', '/w/app-secrets/src')).toBe('');
    });

    it('when nothing has reported a cwd yet', () => {
      expect(relativeRoot('/w/app', undefined)).toBe('');
    });

    it('when the project has no usable path', () => {
      // The config has not loaded, or the project's status is not `ok` — the
      // same two cases `projectRoot()` refuses in main.
      expect(relativeRoot(null, '/w/app/src')).toBe('');
      expect(relativeRoot(undefined, '/w/app/src')).toBe('');
      expect(relativeRoot('', '/w/app/src')).toBe('');
    });
  });
});
