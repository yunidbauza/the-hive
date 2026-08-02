import { beforeEach, describe, expect, it, vi } from 'vitest';

import { colorize } from '@lib/terminal/ansi';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import { useHiveStore } from '@stores/hive-store';

/**
 * The store-facing half of the seam (story 042). It is allowed to know about
 * the store; the component it feeds is not.
 */
describe('StaticTransport', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('replays the whole transcript to a new subscriber', () => {
    const lines = useHiveStore.getState().entities['hero-refresh'].lines;
    const transport = createStaticTransport('hero-refresh');
    const received = vi.fn();

    transport.onData(received);

    expect(received).toHaveBeenCalledTimes(1);
    const chunk = received.mock.calls[0][0] as string;
    // Every fixture line, coloured, in order — this is what makes a session
    // that is opened for the first time show its history rather than nothing.
    expect(chunk.split('\n').filter(Boolean)).toHaveLength(lines.length);
    expect(chunk).toContain(colorize(lines[0].text, lines[0].color));
  });

  it('emits only the new lines when the transcript grows', () => {
    const transport = createStaticTransport('hero-refresh');
    const received = vi.fn();
    transport.onData(received);
    received.mockClear();

    useHiveStore
      .getState()
      .appendEntityLines('hero-refresh', [{ text: 'fresh', color: 'green' }]);

    expect(received).toHaveBeenCalledTimes(1);
    const chunk = received.mock.calls[0][0] as string;
    // Re-sending scrollback the terminal already holds would duplicate the
    // whole transcript on every append.
    expect(chunk).toBe(`${colorize('fresh', 'green')}\n`);
  });

  it('ignores appends to other entities', () => {
    const transport = createStaticTransport('hero-refresh');
    const received = vi.fn();
    transport.onData(received);
    received.mockClear();

    useHiveStore
      .getState()
      .appendEntityLines('webhooks', [{ text: 'elsewhere', color: 'dim' }]);

    expect(received).not.toHaveBeenCalled();
  });

  it('detaches from the store on unsubscribe, leaving nothing to leak', () => {
    const transport = createStaticTransport('hero-refresh');
    const received = vi.fn();
    const unsubscribe = transport.onData(received);
    received.mockClear();

    unsubscribe();
    useHiveStore
      .getState()
      .appendEntityLines('hero-refresh', [{ text: 'after', color: 'ink' }]);

    expect(received).not.toHaveBeenCalled();
  });

  it('gives every subscriber its own replay', () => {
    const transport = createStaticTransport('hero-refresh');
    const first = vi.fn();
    const second = vi.fn();

    transport.onData(first);
    transport.onData(second);

    // A counter shared across subscriptions would let the first subscriber
    // consume the replay and leave the second with a blank terminal.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toBe(first.mock.calls[0][0]);
  });

  it('reads the console transcript for the orchestrator id', () => {
    const transport = createStaticTransport(ORCHESTRATOR_ID);
    const received = vi.fn();

    transport.onData(received);

    // The console is not an entity; story 041 still mounts an ordinary
    // surface for it, which only works if the transport handles this id.
    expect(received.mock.calls[0][0]).toContain('maestro v0.4.2');
  });

  it('stays silent for an unknown id rather than throwing', () => {
    const transport = createStaticTransport('does-not-exist');
    const received = vi.fn();

    transport.onData(received);

    expect(received).not.toHaveBeenCalled();
  });

  it('wipes and replays when the store is reset beneath it', () => {
    const transport = createStaticTransport('hero-refresh');
    const received = vi.fn();
    transport.onData(received);

    useHiveStore
      .getState()
      .appendEntityLines('hero-refresh', [{ text: 'extra', color: 'ink' }]);
    received.mockClear();

    useHiveStore.getState().reset();

    // A diff is meaningless against a shorter transcript; without the clear the
    // surface would keep lines the store no longer has.
    const chunk = received.mock.calls[0][0] as string;
    expect(chunk.startsWith('\u001b[2J\u001b[H')).toBe(true);
    expect(chunk).toContain('claude --resume feat/hero-refresh');
  });

  it('keeps emitting once a capped transcript stops growing', () => {
    /**
     * The regression this file exists to prevent.
     *
     * The orchestrator console is capped (story 041): once full, every push
     * drops the oldest line and appends a new one, so the array length never
     * changes again. A transport that tracked progress by *count* would see no
     * change, emit nothing, and freeze the console on screen while the store
     * kept updating perfectly — silent, with no error to follow.
     */
    const transport = createStaticTransport(ORCHESTRATOR_ID);
    const received = vi.fn();
    transport.onData(received);

    // Simulate a capped window: same length every time, oldest dropped.
    const CAP = 4;
    useHiveStore.setState({
      orchLines: Array.from({ length: CAP }, (_, i) => ({
        text: `seed ${i}`,
        color: 'dim' as const,
      })),
    });
    received.mockClear();

    for (let i = 0; i < 3; i += 1) {
      useHiveStore.setState((state) => ({
        orchLines: [
          ...state.orchLines.slice(1),
          { text: `line ${i}`, color: 'dim' as const },
        ],
      }));
    }

    expect(received).toHaveBeenCalledTimes(3);
    expect(received.mock.calls.map(([chunk]) => chunk as string)).toEqual([
      `${colorize('line 0', 'dim')}\n`,
      `${colorize('line 1', 'dim')}\n`,
      `${colorize('line 2', 'dim')}\n`,
    ]);
  });

  it('replays from scratch when the window slides past everything it saw', () => {
    const transport = createStaticTransport(ORCHESTRATOR_ID);
    const received = vi.fn();
    transport.onData(received);
    received.mockClear();

    // Nothing the subscriber has seen survives, so a diff is meaningless.
    useHiveStore.setState({
      orchLines: [{ text: 'wholly new', color: 'green' }],
    });

    const chunk = received.mock.calls[0][0] as string;
    expect(chunk.startsWith('\u001b[2J\u001b[H')).toBe(true);
    expect(chunk).toContain('wholly new');
  });

  it('is inert in the write and resize directions', () => {
    const transport = createStaticTransport('hero-refresh');

    // The prototype's input is a separate DOM row (043) and there is no
    // backend to inform of geometry — but the methods exist because the
    // interface, not the implementation, is the contract.
    expect(() => transport.write('ls\r')).not.toThrow();
    expect(() => transport.resize(80, 24)).not.toThrow();
  });
});
