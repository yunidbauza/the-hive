import { describe, expect, it, vi } from 'vitest';

import { createBindings } from '../../../../electron/main/ipc/bindings';

function target() {
  return {
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

describe('createBindings', () => {
  it('unbinds every recorded channel exactly once', () => {
    const ipc = target();
    const bindings = createBindings(ipc);

    bindings.record('config:get');
    bindings.record('pty:write');

    bindings.unbindAll();

    expect(ipc.removeHandler).toHaveBeenCalledWith('config:get');
    expect(ipc.removeHandler).toHaveBeenCalledWith('pty:write');
    expect(ipc.removeAllListeners).toHaveBeenCalledWith('config:get');
    expect(ipc.removeAllListeners).toHaveBeenCalledWith('pty:write');
    expect(ipc.removeHandler).toHaveBeenCalledTimes(2);
  });

  it('records a channel once however many times it is registered', () => {
    const ipc = target();
    const bindings = createBindings(ipc);

    bindings.record('pty:write');
    bindings.record('pty:write');

    expect(bindings.size()).toBe(1);
    bindings.unbindAll();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(1);
  });

  it('is idempotent, so a second unbind is a no-op', () => {
    const ipc = target();
    const bindings = createBindings(ipc);

    bindings.record('config:get');
    bindings.unbindAll();
    bindings.unbindAll();

    expect(ipc.removeHandler).toHaveBeenCalledTimes(1);
    expect(bindings.size()).toBe(0);
  });
});
