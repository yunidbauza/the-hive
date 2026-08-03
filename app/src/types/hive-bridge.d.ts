import type { HiveBridge } from '@shared/ipc-contract';

/**
 * The preload bridge, as the renderer sees it (story 083).
 *
 * The import is **type-only**, and that matters: a value import from
 * `@shared/ipc-contract` would pull main-process-adjacent code into the
 * renderer bundle and trip the story 080 lint zone. `electron/shared/` is types
 * and constants precisely so this declaration can exist without a runtime edge
 * between the two processes.
 *
 * Optional, not required: in the browser build there is no bridge, which is the
 * whole point of `isDesktop()`. Declaring it non-optional would let a component
 * write `window.hive.pty.spawn(...)` with no complaint from the compiler and a
 * TypeError in the demo surface.
 */
declare global {
  interface Window {
    hive?: HiveBridge;
  }
}

export {};
