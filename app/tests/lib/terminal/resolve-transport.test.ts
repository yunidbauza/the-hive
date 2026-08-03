import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveTransport } from '@lib/terminal/resolve-transport';
import { ORCHESTRATOR_ID } from '@lib/terminal/static-transport';

/**
 * The PTY transport is a placeholder until story 094, so it is mocked here —
 * which is also what makes the *routing* assertable. Without a distinguishable
 * double, "desktop resolves to the PTY transport" would be untestable until 094
 * lands, and by then the branch would have shipped unverified.
 */
const ptyMarker = { write: vi.fn(), resize: vi.fn(), onData: vi.fn(() => vi.fn()) };
vi.mock('@lib/terminal/pty-transport', () => ({
  createPtyTransport: vi.fn(() => ptyMarker),
}));

const { createPtyTransport } = await import('@lib/terminal/pty-transport');

function withBridge() {
  (window as { hive?: unknown }).hive = { appInfo: () => Promise.resolve({}) };
}

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

describe('resolveTransport', () => {
  it('gives a session the PTY transport on desktop', () => {
    withBridge();

    expect(resolveTransport('sess-1')).toBe(ptyMarker);
    expect(createPtyTransport).toHaveBeenCalledWith('sess-1');
  });

  it('gives a session the recorded transport in a browser', () => {
    const transport = resolveTransport('sess-1');

    expect(transport).not.toBe(ptyMarker);
    expect(createPtyTransport).not.toHaveBeenCalled();
    // Still a real transport, not a stub — the demo surface works.
    expect(typeof transport.onData).toBe('function');
  });

  it('keeps the orchestrator console static in a browser', () => {
    expect(resolveTransport(ORCHESTRATOR_ID)).not.toBe(ptyMarker);
  });

  it('keeps the orchestrator console static ON DESKTOP TOO', () => {
    // The regression this whole branch exists to prevent: the console is a
    // command surface, not a shell (story 041). Giving the desktop build real
    // terminals must not quietly turn it into one.
    withBridge();

    expect(resolveTransport(ORCHESTRATOR_ID)).not.toBe(ptyMarker);
    expect(createPtyTransport).not.toHaveBeenCalled();
  });

  it('satisfies the TerminalTransport contract in both targets', () => {
    for (const id of [ORCHESTRATOR_ID, 'sess-1']) {
      const transport = resolveTransport(id);
      expect(typeof transport.write).toBe('function');
      expect(typeof transport.resize).toBe('function');
      expect(typeof transport.onData).toBe('function');
    }
  });
});
