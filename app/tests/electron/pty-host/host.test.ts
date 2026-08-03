// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createPtyHost, type HostPort } from '../../../electron/pty-host/host';
import type {
  HostCommand,
  HostMessage,
  SpawnCommand,
} from '../../../electron/shared/pty-host-protocol';

/**
 * The host's message loop (story 091).
 *
 * Driven through a fake port, which is the whole reason `host.ts` is separate
 * from `index.ts` — the entry is three lines only Electron can run, and
 * everything worth asserting is here.
 */

/** A fake `parentPort`: records what went up, lets a test push commands down. */
function fakePort() {
  const sent: HostMessage[] = [];
  let deliver: ((event: { data: HostCommand }) => void) | null = null;

  const port: HostPort = {
    postMessage: (message) => {
      sent.push(message);
    },
    on: (_event, listener) => {
      deliver = listener;
    },
  };

  return {
    port,
    sent,
    send(command: HostCommand) {
      if (!deliver) throw new Error('the host never subscribed to the port');
      deliver({ data: command });
    },
  };
}

const SPAWN: SpawnCommand = {
  type: 'spawn',
  sessionId: 'hero-refresh',
  shell: '/bin/zsh',
  args: [],
  cwd: '/repos/apfm-web',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

function recordingSessions() {
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
  };
}

describe('heartbeat', () => {
  it('answers a ping with the same sequence number', () => {
    const { port, sent, send } = fakePort();
    createPtyHost({ port, sessions: recordingSessions(), exit: vi.fn() });

    send({ type: 'ping', seq: 7 });

    expect(sent).toEqual([{ type: 'pong', seq: 7 }]);
  });

  it('answers before doing any session work, so a busy host is not read as hung', () => {
    const { port, sent, send } = fakePort();
    const sessions = recordingSessions();
    createPtyHost({ port, sessions, exit: vi.fn() });

    send({ type: 'ping', seq: 1 });

    // The pong path must not touch sessions at all — a pong queued behind
    // session work would report the host as hung exactly when it is busiest.
    expect(sessions.spawn).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });
});

describe('routing', () => {
  it('hands spawn the whole command plus a way to answer', () => {
    const { port, send } = fakePort();
    const sessions = recordingSessions();
    createPtyHost({ port, sessions, exit: vi.fn() });

    send(SPAWN);

    expect(sessions.spawn).toHaveBeenCalledWith(SPAWN, expect.any(Function));
  });

  it('unpacks write, resize and kill into their operations', () => {
    const { port, send } = fakePort();
    const sessions = recordingSessions();
    createPtyHost({ port, sessions, exit: vi.fn() });

    send({ type: 'write', sessionId: 'a', data: 'ls\r' });
    send({ type: 'resize', sessionId: 'a', cols: 120, rows: 40 });
    send({ type: 'kill', sessionId: 'a', signal: 'SIGTERM' });

    expect(sessions.write).toHaveBeenCalledWith('a', 'ls\r');
    expect(sessions.resize).toHaveBeenCalledWith('a', 120, 40);
    expect(sessions.kill).toHaveBeenCalledWith('a', 'SIGTERM');
  });

  it('gives spawn an emit that reaches the port', () => {
    const { port, sent, send } = fakePort();
    const sessions = recordingSessions();
    sessions.spawn.mockImplementation(
      (command: SpawnCommand, emit: (message: HostMessage) => void) => {
        emit({ type: 'spawned', sessionId: command.sessionId, pid: 42 });
      },
    );
    createPtyHost({ port, sessions, exit: vi.fn() });

    send(SPAWN);

    expect(sent).toEqual([
      { type: 'spawned', sessionId: 'hero-refresh', pid: 42 },
    ]);
  });
});

describe('shutdown', () => {
  it('kills every session before exiting — exiting first would orphan them', async () => {
    const { port, send } = fakePort();
    const sessions = recordingSessions();
    const order: string[] = [];
    sessions.killAll.mockImplementation(() => {
      order.push('killAll');
      return Promise.resolve();
    });
    const exit = vi.fn(() => order.push('exit'));
    createPtyHost({ port, sessions, exit });

    send({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    // This ordering is what stops `claude` processes surviving app quit.
    expect(order).toEqual(['killAll', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits when teardown fails, and says why', async () => {
    const { port, sent, send } = fakePort();
    const sessions = recordingSessions();
    sessions.killAll.mockRejectedValue(new Error('pty would not die'));
    const exit = vi.fn();
    createPtyHost({ port, sessions, exit });

    send({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    // "The app would not quit" is a worse outcome than "teardown failed".
    expect(exit).toHaveBeenCalledWith(1);
    expect(sent).toEqual([
      { type: 'error', message: expect.stringContaining('pty would not die') },
    ]);
  });
});
