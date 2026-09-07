import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useReceiverExposure } from '@hooks/use-project-config';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import {
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
  emptySnapshot,
  type ConfigSnapshot,
  type ReceiverBindConfig,
} from '@shared/config-contract';

const CONFIG_PATH = '/Users/dev/.hive/config.json';

/**
 * A full snapshot with only `receiver.bind` overridden — `emptySnapshot`
 * already fills in `receiver` from `DEFAULT_RECEIVER`, so this only needs to
 * name the one field each test cares about, exactly like every other
 * `@lib/project-config` spec.
 */
function snapshot(bind: Partial<ReceiverBindConfig>): ConfigSnapshot {
  return {
    ...emptySnapshot(CONFIG_PATH),
    receiver: { ...DEFAULT_RECEIVER, bind: { ...DEFAULT_BIND, ...bind } },
  };
}

function renderValue(): string | null {
  const { result } = renderHook(() => useReceiverExposure());
  return result.current;
}

afterEach(() => {
  resetProjectConfig();
});

/**
 * `useReceiverExposure` (HIVE-134).
 *
 * `isLoopbackHost` is the one definition of "exposed", proven here rather than
 * re-derived: the whole `127.0.0.0/8` block reads as not-exposed, not only the
 * canonical `127.0.0.1`, and a missing snapshot — the browser demo target,
 * which has no config at all — reads as not-exposed too rather than throwing.
 */
describe('useReceiverExposure', () => {
  it('is null on the default bind', () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    expect(renderValue()).toBeNull();
  });

  it('is null anywhere in 127.0.0.0/8', () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.2' }));
    expect(renderValue()).toBeNull();
  });

  it('is the address when the bind is widened', () => {
    setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
    expect(renderValue()).toBe('172.17.0.1');
  });

  /* The browser demo has no config at all. */
  it('is null with no snapshot', () => {
    setProjectConfigForTest(null);
    expect(renderValue()).toBeNull();
  });
});
