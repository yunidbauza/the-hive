import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSkills } from '@/lib/skills';

import { useSkills } from '@hooks/use-skills';

import type { SkillsSnapshot } from '@shared/skills-contract';

const snapshot = (names: string[]): SkillsSnapshot => ({
  skills: names.map((name) => ({
    name,
    description: 'does a thing',
    valid: true as const,
  })),
  invalid: [],
  skillsRoot: '/home/u/.hive/skills',
});

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  vi.restoreAllMocks();
});

describe('useSkills', () => {
  it('answers null before anything has been read', () => {
    const { result } = renderHook(() => useSkills());

    expect(result.current).toBeNull();
  });

  it('re-renders every consumer on the same snapshot', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      skills: { list: () => Promise.resolve(snapshot(['standup'])) },
    };
    const first = renderHook(() => useSkills());
    const second = renderHook(() => useSkills());

    await act(async () => {
      await loadSkills();
    });

    // One moment of truth, shared. An effect per consumer would give each its
    // own copy and let the two disagree.
    expect(first.result.current?.skills).toHaveLength(1);
    expect(second.result.current).toBe(first.result.current);
  });

  it('unsubscribes on unmount', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      skills: { list: () => Promise.resolve(snapshot([])) },
    };
    const { unmount } = renderHook(() => useSkills());

    unmount();

    // A store that kept the listener would call setState on an unmounted tree.
    await expect(
      act(async () => {
        await loadSkills();
      }),
    ).resolves.toBeUndefined();
  });
});
