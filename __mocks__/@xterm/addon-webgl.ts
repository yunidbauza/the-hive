import { vi } from 'vitest';

/**
 * Recording fake for xterm's `WebglAddon` (story 095).
 *
 * The real addon needs a WebGL2 context, which happy-dom has no notion of. What
 * unit tests can assert is the *policy* around it — that it is attached only to
 * a visible interactive terminal, disposed when that terminal is hidden, and
 * disposed again when the context is lost — and all of that is plumbing.
 *
 * `emitContextLoss` is the point of this fake. A lost GPU context is otherwise
 * unreproducible in a test, and it is the failure the guard exists for: without
 * the fallback the terminal silently stops painting, which reads as a frozen
 * session rather than as a renderer problem.
 */

export const webglAddonInstances: MockWebglAddon[] = [];

export class MockWebglAddon {
  readonly dispose = vi.fn();
  readonly activate = vi.fn();

  private readonly contextLossListeners = new Set<() => void>();

  constructor() {
    webglAddonInstances.push(this);
  }

  onContextLoss(listener: () => void) {
    this.contextLossListeners.add(listener);
    return { dispose: () => this.contextLossListeners.delete(listener) };
  }

  /** Test helper — simulate the GPU dropping this terminal's context. */
  emitContextLoss() {
    for (const listener of [...this.contextLossListeners]) listener();
  }

  /** How many context-loss listeners are still attached. */
  get contextLossListenerCount() {
    return this.contextLossListeners.size;
  }
}

/** Drop every recorded instance. Call between tests. */
export function resetWebglAddonInstances() {
  webglAddonInstances.length = 0;
}

export { MockWebglAddon as WebglAddon };
