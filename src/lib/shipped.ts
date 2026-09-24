import type {
  ShippedRequest,
  ShippedStatus,
} from '@shared/shipped-contract';

/**
 * The renderer's view of what the user changed in the shipped agents and
 * skills (`shipped-contract.ts`).
 *
 * `agents.ts`'s shape: a module snapshot behind `useSyncExternalStore`, a
 * load that is safe to repeat, and a write that answers with a refusal as a
 * value. Each write answers with the fresh list, so the snapshot never lags
 * what was just done.
 */

let snapshot: ShippedStatus[] | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export function subscribeShipped(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The last list main answered, or `null` before it has, or without a bridge. */
export function shippedSnapshot(): ShippedStatus[] | null {
  return snapshot;
}

/** Ask main again. Safe to call repeatedly; a failed read keeps what was held. */
export async function loadShipped(): Promise<void> {
  const bridge = window.hive;

  if (!bridge) return;

  try {
    snapshot = await bridge.shipped.status();
  } catch (cause) {
    console.error('[hive] could not read the shipped status:', cause);
    return;
  }

  emit();
}

type Verb = 'reset' | 'takePrompt' | 'keepMine';

/** Run one action; `null` when it landed, else the sentence saying why not. */
async function act(verb: Verb, request: ShippedRequest): Promise<string | null> {
  const bridge = window.hive;

  if (!bridge) return 'Only available in the desktop app.';

  try {
    snapshot = await bridge.shipped[verb](request);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  emit();

  return null;
}

export const resetShipped = (request: ShippedRequest): Promise<string | null> =>
  act('reset', request);

export const takeShippedPrompt = (request: ShippedRequest): Promise<string | null> =>
  act('takePrompt', request);

export const keepShippedMine = (request: ShippedRequest): Promise<string | null> =>
  act('keepMine', request);

/** Test-only: drop the snapshot and every subscriber. */
export function resetShippedState(): void {
  snapshot = null;
  listeners.clear();
}
