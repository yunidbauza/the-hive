import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelClone, onCloneDone, startClone } from '@lib/clone-repo';

import { emptySnapshot, type CloneRequest } from '@shared/config-contract';

import {
  projectConfigSnapshot,
  resetProjectConfig,
} from '@lib/project-config';

/**
 * The renderer's half of the clone flow (story 102).
 *
 * There is barely any logic here on purpose — main owns every decision — so
 * what these tests pin down is the degradation rule: no bridge is the browser
 * demo, not a failure, and every verb has to behave in the way its caller
 * already handles.
 */

const REQUEST: CloneRequest = {
  url: 'https://github.com/behiques/the-hive.git',
  parentPath: '/Users/me/Projects',
  cols: 80,
  rows: 24,
};

beforeEach(() => {
  delete (window as { hive?: unknown }).hive;
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  resetProjectConfig();
  vi.clearAllMocks();
});

describe('startClone', () => {
  it('refuses without a bridge rather than throwing', async () => {
    await expect(startClone(REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'cloning is only available in the desktop app',
    });
  });

  it('forwards the request to the bridge verbatim', async () => {
    const startCloneVerb = vi
      .fn()
      .mockResolvedValue({ ok: true, targetPath: '/Users/me/Projects/the-hive' });
    (window as { hive?: unknown }).hive = {
      config: { startClone: startCloneVerb },
    };

    await expect(startClone(REQUEST)).resolves.toEqual({
      ok: true,
      targetPath: '/Users/me/Projects/the-hive',
    });
    expect(startCloneVerb).toHaveBeenCalledWith(REQUEST);
  });

  it('passes a refusal from main straight through', async () => {
    (window as { hive?: unknown }).hive = {
      config: {
        startClone: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'already exists' }),
      },
    };

    await expect(startClone(REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'already exists',
    });
  });
});

describe('cancelClone', () => {
  it('is a no-op without a bridge', async () => {
    await expect(cancelClone()).resolves.toBeUndefined();
  });

  it('calls the bridge verb', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    (window as { hive?: unknown }).hive = { config: { cancelClone: cancel } };

    await cancelClone();

    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('onCloneDone', () => {
  it('returns a no-op unsubscribe without a bridge', () => {
    const unsubscribe = onCloneDone(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it('subscribes through the bridge and returns its disposer', () => {
    const dispose = vi.fn();
    const subscribe = vi.fn().mockReturnValue(dispose);
    (window as { hive?: unknown }).hive = {
      config: { onCloneDone: subscribe },
    };

    const unsubscribe = onCloneDone(vi.fn());

    expect(subscribe).toHaveBeenCalledOnce();
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
  });

  /**
   * The bug this test exists for: a clone concludes on an *event*, long after
   * the call that started it returned, so nothing installs its snapshot unless
   * this does. Without it the project list is still empty after a successful
   * clone — which is exactly what the end-to-end run caught.
   */
  it('installs the event snapshot before the caller sees it', () => {
    // An array rather than a `let`: assigning inside the closure narrows a
    // nullable binding to `never`, and the call below stops type-checking.
    const delivered: ((event: unknown) => void)[] = [];
    (window as { hive?: unknown }).hive = {
      config: {
        onCloneDone: (cb: (event: unknown) => void) => {
          delivered.push(cb);
          return () => {};
        },
      },
    };

    const cloned = {
      ...emptySnapshot('/tmp/config.json'),
      projects: [
        {
          id: 'the-hive',
          name: 'the-hive',
          path: '/repos/the-hive',
          icon: 'ph-folder',
          origin: 'cloned' as const,
          status: 'ok' as const,
          isRepo: true,
        },
      ],
    };

    const callback = vi.fn(() => {
      // Already current by the time the subscriber runs, not after it.
      expect(projectConfigSnapshot()?.projects).toHaveLength(1);
    });
    onCloneDone(callback);

    delivered[0]?.({
      ok: true,
      targetPath: '/repos/the-hive',
      reason: null,
      snapshot: cloned,
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(projectConfigSnapshot()?.projects[0]?.origin).toBe('cloned');
  });
});
