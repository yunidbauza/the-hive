import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSIONS_REQUIRE_DESKTOP,
  SessionRefusedError,
  restartSession,
} from '@features/sessions/session-control';
import { useAppearanceStore } from '@stores/appearance-store';

const REQUEST = {
  entityId: 'hero-refresh',
  projectId: 'nova-web',
  cols: 80,
  rows: 24,
};

function withBridge() {
  const restart = vi.fn(() => Promise.resolve());
  (window as { hive?: unknown }).hive = { pty: { restart } };
  return restart;
}

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  // `appearance-store` persists, so a test that dresses the app in light has to
  // undress it again or every later assertion inherits the change.
  useAppearanceStore.getState().reset();
  vi.clearAllMocks();
});

describe('restartSession', () => {
  it('asks main to restart, addressing the session by entity id', () => {
    const restart = withBridge();

    void restartSession(REQUEST);

    // The renderer never sees a pty session id — main mints one and maps it.
    expect(restart).toHaveBeenCalledWith({
      sessionId: 'hero-refresh',
      projectId: 'nova-web',
      cols: 80,
      rows: 24,
    });
  });

  /**
   * A restart no longer carries a theme, and no longer needs to (HIVE-82).
   *
   * It used to be the only moment a running session could change one, because
   * `claude` reads its settings file once at startup — which is exactly what
   * made a theme toggle leave running agents dressed the way they started.
   * Claude's theme is pinned to `dark-ansi` now, so every colour it emits is an
   * ANSI index that xterm resolves against the active palette at paint time. A
   * toggle repaints running sessions without restarting anything, so a restart
   * has nothing left to carry.
   */
  it('sends no theme, because a restart is no longer how one is changed', () => {
    const restart = withBridge();
    useAppearanceStore.setState({ theme: 'light' });

    void restartSession(REQUEST);

    expect(restart).toHaveBeenCalledWith(
      expect.not.objectContaining({ theme: expect.anything() }),
    );
  });

  it('refuses in the browser with the message for that refusal', async () => {
    /**
     * The one precondition main cannot evaluate, because in the browser build
     * there is no main. The other three live in `session-contract.ts`, which
     * `src/**` may only import type-only — so the wording is split along the
     * process boundary rather than duplicated across it.
     */
    await expect(restartSession(REQUEST)).rejects.toThrow(SESSIONS_REQUIRE_DESKTOP);
  });

  it('carries the machine-readable reason alongside the message', async () => {
    await expect(restartSession(REQUEST)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionRefusedError && error.refusal.reason === 'not-desktop',
    );
  });

  it('throws rather than resolving, so a caller cannot ignore it by accident', async () => {
    const outcome = await restartSession(REQUEST).then(
      () => 'resolved',
      () => 'rejected',
    );

    expect(outcome).toBe('rejected');
  });
});
