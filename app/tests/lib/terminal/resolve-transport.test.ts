import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLiveTerminal, resolveTransport } from '@lib/terminal/resolve-transport';
import { ORCHESTRATOR_ID } from '@lib/terminal/static-transport';

/**
 * The PTY transport is mocked here so the *routing* is assertable without a
 * bridge behind it. Story 083 introduced the double when the transport was a
 * placeholder; now that it is real (story 094) the double earns its keep for a
 * different reason — resolving a session must not spawn a process just because
 * a test asked which transport it gets.
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

/** A real fixture session, because the project id now has to resolve. */
const SESSION_ID = 'hero-refresh';
const SESSION_PROJECT = 'apfm-web';

describe('resolveTransport', () => {
  it('gives a session the PTY transport on desktop, with its project', () => {
    withBridge();

    expect(resolveTransport(SESSION_ID)).toBe(ptyMarker);
    /**
     * The project id travels as an *argument*, which is the whole reason this
     * lookup lives in `resolveTransport` and not in `PtyTransport`: a PTY needs
     * a `cwd`, and the transport is not allowed to read a store to find one.
     */
    expect(createPtyTransport).toHaveBeenCalledWith(SESSION_ID, SESSION_PROJECT);
  });

  it('keeps an agent on its recorded transcript, even on desktop', () => {
    // Agents are background workers with no project and no branch (story 096's
    // scope note). A PTY would have no directory to spawn in.
    withBridge();

    expect(resolveTransport('slack-agent')).not.toBe(ptyMarker);
    expect(createPtyTransport).not.toHaveBeenCalled();
  });

  it('keeps an unknown entity static rather than guessing a project', () => {
    withBridge();

    expect(resolveTransport('no-such-entity')).not.toBe(ptyMarker);
    expect(createPtyTransport).not.toHaveBeenCalled();
  });

  it('gives a session the recorded transport in a browser', () => {
    const transport = resolveTransport(SESSION_ID);

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
    for (const id of [ORCHESTRATOR_ID, SESSION_ID]) {
      const transport = resolveTransport(id);
      expect(typeof transport.write).toBe('function');
      expect(typeof transport.resize).toBe('function');
      expect(typeof transport.onData).toBe('function');
    }
  });
});

/**
 * `isLiveTerminal` is the same question `resolveTransport` answers, exposed so
 * `readOnly` and the key-hint row cannot drift from the transport (story 095).
 *
 * The drift it prevents is specific and ugly: a surface that reports itself
 * typable while its transport is a recording blinks a cursor and swallows every
 * keystroke, which reads as a hung session rather than a read-only one.
 */
describe('isLiveTerminal', () => {
  it('agrees with resolveTransport on every case', () => {
    withBridge();

    for (const id of [SESSION_ID, 'slack-agent', 'no-such-entity', ORCHESTRATOR_ID]) {
      const live = isLiveTerminal(id);
      vi.clearAllMocks();
      resolveTransport(id);
      expect(vi.mocked(createPtyTransport).mock.calls.length > 0).toBe(live);
    }
  });

  it('is true only for a mapped session on desktop', () => {
    withBridge();

    expect(isLiveTerminal(SESSION_ID)).toBe(true);
    expect(isLiveTerminal('slack-agent')).toBe(false);
    expect(isLiveTerminal(ORCHESTRATOR_ID)).toBe(false);
    expect(isLiveTerminal('no-such-entity')).toBe(false);
  });

  it('is false for everything in the browser', () => {
    // The demo surface is a recording end to end — story 083's condition for
    // the browser target surviving at all is that it degrades visibly.
    expect(isLiveTerminal(SESSION_ID)).toBe(false);
    expect(isLiveTerminal(ORCHESTRATOR_ID)).toBe(false);
  });
});
