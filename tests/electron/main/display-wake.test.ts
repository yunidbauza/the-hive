// @vitest-environment node
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { monitor, displays, state } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events');
  return {
    monitor: new Emitter(),
    displays: new Emitter(),
    state: { screenThrows: false, noLifecycle: false },
  };
});

vi.mock('electron', () => ({
  app: {
    whenReady: () => {
      if (state.noLifecycle) throw new TypeError('whenReady is not a function');
      return Promise.resolve();
    },
  },
  powerMonitor: monitor,
  get screen() {
    if (state.screenThrows) throw new Error('screen before ready');
    return displays;
  },
}));

import { DISPLAY_WAKE_SETTLE_MS, onDisplayWake } from '../../../electron/main/display-wake';

let stop: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  state.screenThrows = false;
  state.noLifecycle = false;
});

afterEach(() => {
  stop();
  monitor.removeAllListeners();
  displays.removeAllListeners();
  vi.useRealTimers();
});

/** Let `whenReady` resolve, which is when the subscriptions are made. */
const ready = () => vi.advanceTimersByTimeAsync(0);

describe('onDisplayWake', () => {
  it.each([
    ['resume', monitor],
    ['unlock-screen', monitor],
    ['display-added', displays],
  ] as const)('calls the listener after %s settles', async (event, emitter) => {
    const listener = vi.fn();
    stop = onDisplayWake(listener);
    await ready();

    (emitter as EventEmitter).emit(event);
    vi.advanceTimersByTime(DISPLAY_WAKE_SETTLE_MS - 1);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of wake signals into one call', async () => {
    const listener = vi.fn();
    stop = onDisplayWake(listener);
    await ready();

    monitor.emit('resume');
    monitor.emit('unlock-screen');
    displays.emit('display-added');
    vi.advanceTimersByTime(DISPLAY_WAKE_SETTLE_MS);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops listening, and drops a pending call, once stopped', async () => {
    const listener = vi.fn();
    stop = onDisplayWake(listener);
    await ready();

    monitor.emit('resume');
    stop();
    vi.advanceTimersByTime(DISPLAY_WAKE_SETTLE_MS);
    monitor.emit('resume');
    vi.advanceTimersByTime(DISPLAY_WAKE_SETTLE_MS);

    expect(listener).not.toHaveBeenCalled();
    expect(monitor.listenerCount('resume')).toBe(0);
  });

  it('subscribes nothing when stopped before the app is ready', async () => {
    stop = onDisplayWake(vi.fn());
    stop();
    await ready();

    expect(monitor.listenerCount('resume')).toBe(0);
    expect(displays.listenerCount('display-added')).toBe(0);
  });

  it('subscribes nothing, and does not throw, with no app lifecycle', async () => {
    state.noLifecycle = true;

    expect(() => (stop = onDisplayWake(vi.fn()))).not.toThrow();
    await ready();

    expect(monitor.listenerCount('resume')).toBe(0);
  });

  it('still hears the power monitor when screen is unavailable', async () => {
    state.screenThrows = true;
    const listener = vi.fn();
    stop = onDisplayWake(listener);
    await ready();

    monitor.emit('resume');
    vi.advanceTimersByTime(DISPLAY_WAKE_SETTLE_MS);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
