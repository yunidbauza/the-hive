import { describe, expect, it, vi } from 'vitest';

import { CH } from '../../../../electron/shared/ipc-contract';
import { createIpcRegistry } from '../../../../electron/main/ipc/registry';

describe('createIpcRegistry', () => {
  it('returns a recorded call handler by channel name', () => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => 'answer');
    registry.recordCall(CH.configGet, handler);

    expect(registry.call(CH.configGet)).toBe(handler);
    expect(registry.notify(CH.configGet)).toBeNull();
  });

  it('returns a recorded notify handler by channel name', () => {
    const registry = createIpcRegistry();
    const handler = vi.fn();
    registry.recordNotify(CH.ptyAck, handler);

    expect(registry.notify(CH.ptyAck)).toBe(handler);
    expect(registry.call(CH.ptyAck)).toBeNull();
  });

  it('returns null for a channel nobody recorded', () => {
    const registry = createIpcRegistry();

    expect(registry.call('not:a:channel')).toBeNull();
    expect(registry.notify('not:a:channel')).toBeNull();
  });

  it('is empty after clear, so one test cannot leak handlers into the next', () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configGet, vi.fn());
    registry.recordNotify(CH.ptyAck, vi.fn());
    expect(registry.size()).toBe(2);

    registry.clear();

    expect(registry.size()).toBe(0);
    expect(registry.call(CH.configGet)).toBeNull();
  });

  it('keeps calls and notifies in separate namespaces', () => {
    const registry = createIpcRegistry();
    const call = vi.fn(() => 1);
    const notify = vi.fn();
    registry.recordCall(CH.appInfo, call);
    registry.recordNotify(CH.ptyWrite, notify);

    expect(registry.call(CH.ptyWrite)).toBeNull();
    expect(registry.notify(CH.appInfo)).toBeNull();
  });
});
