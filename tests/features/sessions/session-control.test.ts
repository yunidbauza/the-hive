import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSIONS_REQUIRE_DESKTOP,
  SessionRefusedError,
  restartSession,
} from '@features/sessions/session-control';
import { useAppearanceStore } from '@stores/appearance-store';

const REQUEST = {
  entityId: 'hero-refresh',
  projectId: 'apfm-web',
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
      projectId: 'apfm-web',
      cols: 80,
      rows: 24,
      // The app's theme, always sent — see the assertions below for why it is
      // read here rather than carried on the request.
      theme: 'dark',
    });
  });

  /**
   * A restart is the only moment a running session can change theme: `claude`
   * reads its settings file once, at startup. Three comments in main say so,
   * and for a while nothing sent the value that made them true.
   */
  it('dresses the new process in the app’s current theme', () => {
    const restart = withBridge();
    useAppearanceStore.setState({ theme: 'light' });

    void restartSession(REQUEST);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'light' }),
    );
  });

  /** `system` is a preference, not a palette — the wire only takes resolved. */
  it('resolves the system preference before sending it', () => {
    const restart = withBridge();
    useAppearanceStore.setState({ theme: 'system', systemDark: true });

    void restartSession(REQUEST);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
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
