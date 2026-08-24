import { useSyncExternalStore } from 'react';

import { skillsSnapshot, subscribeSkills } from '@lib/skills';
import type { SkillsSnapshot } from '@shared/skills-contract';

/**
 * Reading the custom skills from a component (HIVE-96).
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, for the reason
 * `use-project-config.ts` states: the snapshot lands once, asynchronously, and
 * every consumer has to re-render on the same moment of truth. An effect per
 * consumer would give each its own copy.
 *
 * This is the named selector hook `AGENTS.md` requires — components never reach
 * into `@lib/skills` directly, exactly as they never reach into a store.
 */
export function useSkills(): SkillsSnapshot | null {
  return useSyncExternalStore(subscribeSkills, skillsSnapshot, skillsSnapshot);
}
