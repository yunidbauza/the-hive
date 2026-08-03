import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSIONS_REQUIRE_DESKTOP,
  SessionRefusedError,
  restartSession,
} from '@features/sessions/session-control';

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
    });
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
