/**
 * The shutdown registry (story 081).
 *
 * Empty by design right now. It exists before anything needs it so that killing
 * PTYs later (story 096) is a *registration* rather than a refactor of the quit
 * path — and so `before-quit` is already async-correct before the first thing
 * that must be awaited shows up.
 *
 * The failure this prevents: `before-quit` is synchronous by default, so a hook
 * added later that returns a promise is fire-and-forget. The app exits while
 * child processes are still being signalled, and `claude` keeps running in the
 * background forever. That bug is invisible until someone checks `ps`.
 */

export type ShutdownHook = () => void | Promise<void>;

const hooks: ShutdownHook[] = [];

/** Register work that must finish before the app exits. Returns a disposer. */
export function onShutdown(hook: ShutdownHook): () => void {
  hooks.push(hook);
  return () => {
    const at = hooks.indexOf(hook);
    if (at !== -1) hooks.splice(at, 1);
  };
}

/**
 * Run every hook and wait for all of them.
 *
 * `allSettled`, not `all`: one hook that throws must not strand the others,
 * because "the app would not quit" is a worse outcome than "one teardown step
 * failed". Rejections are logged, never swallowed silently.
 */
export async function runShutdown(): Promise<void> {
  const results = await Promise.allSettled(hooks.map((hook) => hook()));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[hive] shutdown hook failed:', result.reason);
    }
  }
}

/** Test-only: drop every registered hook. */
export function resetShutdownHooks(): void {
  hooks.length = 0;
}

/** Test-only: how many hooks are registered. */
export const shutdownHookCount = (): number => hooks.length;
