// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one writer of this machine's dock badge (HIVE-159).
 *
 * Two callers reach it — the hub in local mode, the renderer's report while
 * attached — and the count arrives from the renderer as an IPC payload, so the
 * guard is part of the contract rather than belt and braces.
 */

const setBadge = vi.fn();

vi.mock('electron', () => ({
  app: { dock: { setBadge } },
}));

const { badgeDock, clearDockBadge } = await import(
  '../../../../electron/main/notifications/dock-badge'
);

beforeEach(() => {
  setBadge.mockClear();
});

describe('badgeDock', () => {
  it('writes a positive count as its digits', () => {
    badgeDock(3);

    expect(setBadge).toHaveBeenCalledWith('3');
  });

  it('clears with an empty string rather than writing 0', () => {
    badgeDock(0);

    expect(setBadge).toHaveBeenCalledWith('');
  });

  it.each([
    ['a negative count', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '3'],
    ['null', null],
    ['undefined', undefined],
  ])('ignores %s rather than writing it', (_name, payload) => {
    badgeDock(payload);

    expect(setBadge).not.toHaveBeenCalled();
  });
});

describe('clearDockBadge', () => {
  it('clears the badge', () => {
    clearDockBadge();

    expect(setBadge).toHaveBeenCalledWith('');
  });
});
