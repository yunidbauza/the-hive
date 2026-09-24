import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keepShippedMine,
  loadShipped,
  resetShipped,
  resetShippedState,
  shippedSnapshot,
  subscribeShipped,
  takeShippedPrompt,
} from '@/lib/shipped';

import { shippedStatus } from '../support/shipped';

const setBridge = (shipped: Record<string, unknown> | undefined): void => {
  (window as unknown as { hive?: unknown }).hive = shipped === undefined ? undefined : { shipped };
};

beforeEach(() => {
  setBridge(undefined);
  resetShippedState();
  vi.restoreAllMocks();
});

describe('loadShipped', () => {
  it('does nothing without a bridge', async () => {
    await loadShipped();

    expect(shippedSnapshot()).toBeNull();
  });

  it('holds what main answers and tells every subscriber', async () => {
    const list = [shippedStatus()];
    const listener = vi.fn();
    setBridge({ status: () => Promise.resolve(list) });
    subscribeShipped(listener);

    await loadShipped();

    expect(shippedSnapshot()).toBe(list);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the last list when a read fails', async () => {
    const list = [shippedStatus()];
    setBridge({ status: () => Promise.resolve(list) });
    await loadShipped();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setBridge({ status: () => Promise.reject(new Error('gone')) });

    await loadShipped();

    expect(shippedSnapshot()).toBe(list);
  });
});

describe('the actions', () => {
  it('send the request, and hold the fresh list main answers', async () => {
    const fresh = [shippedStatus({ name: 'fixer' })];
    const reset = vi.fn(() => Promise.resolve(fresh));
    const takePrompt = vi.fn(() => Promise.resolve(fresh));
    const keepMine = vi.fn(() => Promise.resolve(fresh));
    setBridge({ reset, takePrompt, keepMine });
    const request = { kind: 'agents', name: 'builder' } as const;

    expect(await resetShipped(request)).toBeNull();
    expect(await takeShippedPrompt(request)).toBeNull();
    expect(await keepShippedMine(request)).toBeNull();

    expect(reset).toHaveBeenCalledWith(request);
    expect(takePrompt).toHaveBeenCalledWith(request);
    expect(keepMine).toHaveBeenCalledWith(request);
    expect(shippedSnapshot()).toBe(fresh);
  });

  it('answer a refusal as a sentence, and keep the list', async () => {
    setBridge({ reset: () => Promise.reject(new Error('The Hive does not ship agents/x.')) });

    expect(await resetShipped({ kind: 'agents', name: 'x' })).toBe('The Hive does not ship agents/x.');
    expect(shippedSnapshot()).toBeNull();
  });

  it('say so without a bridge', async () => {
    expect(await keepShippedMine({ kind: 'skills', name: 'tdd' })).toMatch(/desktop app/);
  });
});
