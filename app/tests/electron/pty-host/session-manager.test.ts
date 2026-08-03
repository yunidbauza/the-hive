// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  MockPty,
  resetPtyMock,
  spawn as mockSpawn,
  spawnCalls,
  ptyInstances,
} from '../../../__mocks__/node-pty';
import { TERM } from '../../../electron/pty-host/env';
import {
  createSessionManager,
  type SessionManager,
} from '../../../electron/pty-host/session-manager';
import {
  TRUNCATION_NOTICE,
  type HostMessage,
  type SpawnCommand,
} from '../../../electron/shared/pty-host-protocol';

/**
 * The PTY session manager (story 092).
 *
 * `node-pty` is mocked — not because the real module cannot load (its N-API
 * prebuild works fine under plain Node) but because **a unit test that spawns
 * real processes is a unit test that leaks them**. Every `spawn()` would be a
 * fork, a pty pair, and a child that outlives a failing assertion.
 *
 * So this file asserts *plumbing*: spawn arguments, the sanitised environment,
 * decoding, buffering, routing, and teardown ordering. Everything about real
 * terminal behaviour — that SIGINT actually arrives, that SIGWINCH actually
 * reaches the child, that `vim` renders — is unprovable with a mock and
 * belongs to story 098.
 */

const SPAWN: SpawnCommand = {
  type: 'spawn',
  sessionId: 'hero-refresh',
  shell: '/bin/zsh',
  args: ['-l'],
  cwd: '/repos/apfm-web',
  env: {},
  cols: 80,
  rows: 24,
};

let manager: SessionManager;
let sent: HostMessage[];
let killGroup: Mock<(pid: number, signal: NodeJS.Signals) => void>;
let emit: (message: HostMessage) => void;

/** A base environment carrying one of everything the deny-list cares about. */
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  LANG: 'en_US.UTF-8',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  NODE_OPTIONS: '--max-old-space-size=8192',
  NODE_PATH: '/Applications/Electron.app/Contents/Resources/node_modules',
  GDK_PIXBUF_MODULE_FILE: '/tmp/loaders.cache',
  CHROME_DESKTOP: 'electron.desktop',
  TERM: 'dumb',
};

function build(overrides: Parameters<typeof createSessionManager>[0] = {}) {
  return createSessionManager({
    baseEnv: BASE_ENV,
    killGroup,
    spawn: mockSpawn as never,
    ...overrides,
  });
}

/** The pty backing the most recent spawn. */
const pty = (): MockPty => {
  const last = ptyInstances.at(-1);
  if (!last) throw new Error('nothing was spawned');
  return last;
};

const dataChunks = (): string[] =>
  sent.filter((m) => m.type === 'data').map((m) => m.chunk);

const spawnEnv = (): Record<string, string> =>
  spawnCalls.at(-1)!.options.env as Record<string, string>;

beforeEach(() => {
  resetPtyMock();
  sent = [];
  emit = (message) => sent.push(message);
  killGroup = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  manager = build();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('spawn arguments', () => {
  it('sets TERM to xterm-256color — the single most consequential option', () => {
    manager.spawn(SPAWN, emit);

    // It is how every program in the terminal decides what it may emit. Get it
    // wrong and colours silently vanish or garbage appears.
    expect(spawnCalls.at(-1)?.options.name).toBe('xterm-256color');
    expect(spawnEnv().TERM).toBe(TERM);
  });

  it('advertises truecolor, so tools do not quantise to 256', () => {
    manager.spawn(SPAWN, emit);

    expect(spawnEnv().COLORTERM).toBe('truecolor');
  });

  it('spawns the resolved shell, args and cwd it was handed', () => {
    manager.spawn(SPAWN, emit);

    const call = spawnCalls.at(-1)!;
    expect(call.file).toBe('/bin/zsh');
    expect(call.args).toEqual(['-l']);
    // The cwd arrives already resolved from story 090 — the host does not
    // know what a project is.
    expect(call.options.cwd).toBe('/repos/apfm-web');
    expect(spawnEnv().PWD).toBe('/repos/apfm-web');
  });

  it('asks for Buffers, not strings', () => {
    manager.spawn(SPAWN, emit);

    // `encoding: null` is what makes the StringDecoder below meaningful.
    expect(spawnCalls.at(-1)?.options.encoding).toBeNull();
  });

  it('reports the pid so main can supervise the session', () => {
    manager.spawn(SPAWN, emit);

    expect(sent).toContainEqual({
      type: 'spawned',
      sessionId: 'hero-refresh',
      pid: 4242,
    });
  });
});

describe('environment sanitisation', () => {
  it.each([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'NODE_OPTIONS',
    // Not in the story's list. Electron's launcher points it at Electron's own
    // bundled node_modules, so a `node` the user runs would resolve modules
    // from there instead of their project — the same invisible behaviour
    // change NODE_OPTIONS is denied for. Found by spawning a real shell.
    'NODE_PATH',
    'GDK_PIXBUF_MODULE_FILE',
    'CHROME_DESKTOP',
  ])('strips %s', (key) => {
    manager.spawn(SPAWN, emit);

    // This is the bug class that produces "it works in my terminal but not in
    // the app", and it is invisible until something behaves strangely.
    expect(spawnEnv()).not.toHaveProperty(key);
  });

  it("leaves the user's own variables alone", () => {
    manager.spawn(SPAWN, emit);

    expect(spawnEnv()).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/dev',
      LANG: 'en_US.UTF-8',
    });
  });

  it('overrides an inherited TERM rather than trusting it', () => {
    // The base env says `dumb`; a terminal that inherited that would render
    // nothing interactive at all.
    manager.spawn(SPAWN, emit);

    expect(spawnEnv().TERM).toBe('xterm-256color');
  });

  it('applies what main injected, but never lets it smuggle a denied key', () => {
    manager.spawn(
      {
        ...SPAWN,
        env: { HIVE_SESSION: 'hero-refresh', ELECTRON_RUN_AS_NODE: '1' },
      },
      emit,
    );

    expect(spawnEnv().HIVE_SESSION).toBe('hero-refresh');
    expect(spawnEnv()).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });
});

describe('UTF-8 across chunk boundaries', () => {
  it('joins a character split across two reads into one', () => {
    manager.spawn(SPAWN, emit);
    // U+2500 BOX DRAWINGS LIGHT HORIZONTAL — e2 94 80.
    const full = Buffer.from('─', 'utf8');

    pty().emitData(full.subarray(0, 2));
    pty().emitData(full.subarray(2));

    // Decoding each chunk independently would emit replacement characters,
    // permanently — the damage happens before the bytes reach xterm.
    expect(dataChunks().join('')).toBe('─');
    expect(dataChunks().join('')).not.toContain('�');
  });

  it('emits nothing for a chunk that is only a partial character', () => {
    manager.spawn(SPAWN, emit);

    pty().emitData(Buffer.from('─', 'utf8').subarray(0, 2));

    // Nothing complete yet, so nothing is sent. A `data` message carrying half
    // a character is a corrupted terminal.
    expect(dataChunks()).toEqual([]);
  });

  it('handles an emoji split across a read boundary', () => {
    manager.spawn(SPAWN, emit);
    const emoji = Buffer.from('🐝', 'utf8');

    pty().emitData(emoji.subarray(0, 1));
    pty().emitData(emoji.subarray(1, 3));
    pty().emitData(emoji.subarray(3));

    expect(dataChunks().join('')).toBe('🐝');
  });

  it('flushes a dangling partial character when the process exits', () => {
    manager.spawn(SPAWN, emit);

    pty().emitData(Buffer.from('ok'));
    pty().emitData(Buffer.from('─', 'utf8').subarray(0, 2));
    pty().emitExit(0);

    // Whatever the decoder was holding is flushed rather than lost, so a
    // transcript never simply stops mid-character.
    expect(dataChunks().join('')).toContain('ok');
    expect(sent.at(-1)?.type).toBe('exit');
  });
});

describe('bounded scrollback', () => {
  it('replays everything a late-mounting surface missed', () => {
    manager.spawn(SPAWN, emit);

    pty().emitData(Buffer.from('first\r\n'));
    pty().emitData(Buffer.from('second\r\n'));

    expect(manager.replay('hero-refresh')).toBe('first\r\nsecond\r\n');
  });

  it('bounds at its cap and marks the transcript as truncated', () => {
    manager = build({ scrollbackBytes: 64 });
    manager.spawn(SPAWN, emit);

    for (let i = 0; i < 20; i += 1) {
      pty().emitData(Buffer.from(`line-${i}-padding\r\n`));
    }

    const replay = manager.replay('hero-refresh')!;
    // A partial transcript that does not announce itself reads as a complete
    // one, and the user draws conclusions from a log missing its first half.
    expect(replay.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(replay).toContain('line-19');
    expect(replay).not.toContain('line-0-');
  });

  it('does not mark a transcript that fits', () => {
    manager.spawn(SPAWN, emit);
    pty().emitData(Buffer.from('short'));

    expect(manager.replay('hero-refresh')).toBe('short');
  });

  it('keeps the transcript after the process dies', () => {
    manager.spawn(SPAWN, emit);
    pty().emitData(Buffer.from('the error you needed to read\r\n'));

    pty().emitExit(1);

    // A terminal that clears itself the instant a process dies destroys the
    // error the user was reaching for.
    expect(manager.replay('hero-refresh')).toContain('the error you needed');
    expect(manager.isLive('hero-refresh')).toBe(false);
    expect(manager.sessionIds()).toEqual(['hero-refresh']);
  });

  it('answers null for a session that never existed', () => {
    expect(manager.replay('ghost')).toBeNull();
  });
});

describe('write', () => {
  it('passes bytes through verbatim, adding nothing', () => {
    manager.spawn(SPAWN, emit);

    manager.write('hero-refresh', 'ls -la');

    // A transport that helpfully appended a newline would break every
    // interactive prompt.
    expect(pty().write).toHaveBeenCalledWith('ls -la');
  });

  it('passes control characters straight through', () => {
    manager.spawn(SPAWN, emit);

    manager.write('hero-refresh', '\x03');

    // Ctrl-C is a byte, not a command. Interpreting it here would take SIGINT
    // away from the pty, which is the thing that makes it work.
    expect(pty().write).toHaveBeenCalledWith('\x03');
  });

  it('ignores a write to an unknown or exited session', () => {
    manager.spawn(SPAWN, emit);
    pty().emitExit(0);

    manager.write('hero-refresh', 'too late');
    manager.write('ghost', 'nobody');

    expect(pty().write).not.toHaveBeenCalled();
  });
});

describe('resize', () => {
  it('resizes the pty, which is what raises SIGWINCH', () => {
    manager.spawn(SPAWN, emit);

    manager.resize('hero-refresh', 120, 40);

    expect(pty().resize).toHaveBeenCalledWith(120, 40);
  });

  it('drops a zero-size resize rather than clamping it', () => {
    manager.spawn(SPAWN, emit);

    manager.resize('hero-refresh', 0, 0);

    /**
     * Dropped, not clamped — corrected by the conformance suite (story 098),
     * which spawned a real shell, resized it to 0×0 and found it produced
     * nothing legible afterwards.
     *
     * xterm reports 0 transiently while its container is hidden or mid-layout,
     * and a pty resized to zero columns puts curses applications into states
     * they do not recover from. Clamping to 1 was the same catastrophe one
     * column wider — and nothing resizes it back, because the renderer's own
     * geometry never changed and so it never sends anything new. A nonsensical
     * size is a frame of bad measurement to ignore, not a request to honour
     * approximately.
     */
    expect(pty().resize).not.toHaveBeenCalled();
  });

  it('drops a negative resize too', () => {
    manager.spawn(SPAWN, emit);

    manager.resize('hero-refresh', -10, -4);

    expect(pty().resize).not.toHaveBeenCalled();
  });

  it('still applies the next valid resize after dropping a bad one', () => {
    manager.spawn(SPAWN, emit);

    // The guard must not latch: a hidden container reporting 0×0 for a frame
    // cannot be allowed to freeze the geometry for the rest of the session.
    manager.resize('hero-refresh', 0, 0);
    manager.resize('hero-refresh', 120, 40);

    expect(pty().resize).toHaveBeenCalledExactlyOnceWith(120, 40);
  });

  it('drops a resize that changes nothing', () => {
    manager.spawn(SPAWN, emit);

    manager.resize('hero-refresh', 80, 24);

    // A no-op resize is still a SIGWINCH and still a full redraw in the child.
    expect(pty().resize).not.toHaveBeenCalled();
  });

  it('drops a duplicate of a resize it just applied', () => {
    manager.spawn(SPAWN, emit);

    manager.resize('hero-refresh', 120, 40);
    manager.resize('hero-refresh', 120, 40);

    expect(pty().resize).toHaveBeenCalledTimes(1);
  });

  it('ignores a resize for an exited session', () => {
    manager.spawn(SPAWN, emit);
    pty().emitExit(0);

    manager.resize('hero-refresh', 120, 40);

    expect(pty().resize).not.toHaveBeenCalled();
  });
});

describe('kill', () => {
  it('signals the process group, not just the shell', () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    manager.kill('hero-refresh');

    // SIGTERM to the shell alone leaves `claude` — and anything it spawned —
    // running with a dangling pty. The negative pid is the group.
    expect(killGroup).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('escalates to SIGKILL when the grace period expires', () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    manager.kill('hero-refresh');
    vi.advanceTimersByTime(2_000);

    expect(killGroup).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
  });

  it('does not escalate against a process that already died', () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    manager.kill('hero-refresh');
    pty().emitExit(0, 15);
    vi.advanceTimersByTime(2_000);

    expect(killGroup).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit signal', () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    manager.kill('hero-refresh', 'SIGHUP');

    expect(killGroup).toHaveBeenCalledWith(4242, 'SIGHUP');
  });

  it('survives a process that vanished between the decision and the signal', () => {
    vi.useFakeTimers();
    killGroup.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    manager.spawn(SPAWN, emit);

    // ESRCH is the ordinary race, not a failure worth taking the app down for.
    expect(() => manager.kill('hero-refresh')).not.toThrow();
  });
});

describe('killAll', () => {
  it('resolves immediately with nothing running', async () => {
    await expect(manager.killAll()).resolves.toBeUndefined();
    expect(killGroup).not.toHaveBeenCalled();
  });

  it('terminates every live group and waits for them to go', async () => {
    manager.spawn(SPAWN, emit);
    const first = pty();
    manager.spawn({ ...SPAWN, sessionId: 'lead-form' }, emit);
    const second = pty();

    const pending = manager.killAll();
    expect(killGroup).toHaveBeenCalledTimes(2);

    first.emitExit(0);
    second.emitExit(0);
    await pending;

    // Both left on request, so neither needed SIGKILL.
    expect(killGroup.mock.calls.every(([, sig]) => sig === 'SIGTERM')).toBe(true);
  });

  it('SIGKILLs whatever is still alive when the grace expires', async () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    const pending = manager.killAll();
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    // Orphan-freedom is the point: the app must not quit while a `claude` it
    // started is still running.
    expect(killGroup).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('ignores sessions that already exited', async () => {
    manager.spawn(SPAWN, emit);
    pty().emitExit(0);

    await manager.killAll();

    expect(killGroup).not.toHaveBeenCalled();
  });
});

describe('the session cap', () => {
  it('refuses past the cap with a typed error rather than fork-bombing', () => {
    manager = build({ maxSessions: 2 });

    manager.spawn({ ...SPAWN, sessionId: 'a' }, emit);
    manager.spawn({ ...SPAWN, sessionId: 'b' }, emit);
    manager.spawn({ ...SPAWN, sessionId: 'c' }, emit);

    expect(manager.sessionIds()).toEqual(['a', 'b']);
    expect(sent).toContainEqual({
      type: 'error',
      sessionId: 'c',
      message: expect.stringContaining('session limit reached (2)'),
    });
  });

  it('counts live sessions, not retained transcripts', () => {
    manager = build({ maxSessions: 1 });

    manager.spawn({ ...SPAWN, sessionId: 'a' }, emit);
    pty().emitExit(0);

    manager.spawn({ ...SPAWN, sessionId: 'b' }, emit);

    // The exited entry is kept so its transcript survives, but it owns no
    // process. Counting it would mean an app that opened and closed 24
    // sessions could never open a 25th.
    expect(manager.isLive('b')).toBe(true);
    expect(sent.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('refuses a session id it already has', () => {
    manager.spawn(SPAWN, emit);
    manager.spawn(SPAWN, emit);

    expect(ptyInstances).toHaveLength(1);
    expect(sent).toContainEqual({
      type: 'error',
      sessionId: 'hero-refresh',
      message: expect.stringContaining('already exists'),
    });
  });

  it('reports a shell that will not start instead of throwing', () => {
    manager = build({
      spawn: (() => {
        throw new Error('posix_spawnp failed');
      }) as never,
    });

    manager.spawn(SPAWN, emit);

    // A throw here would take the whole host down, and with it every other
    // session it owns.
    expect(sent).toContainEqual({
      type: 'error',
      sessionId: 'hero-refresh',
      message: expect.stringContaining('posix_spawnp failed'),
    });
    expect(manager.sessionIds()).toEqual([]);
  });
});

describe('exit', () => {
  it('reports the exit code and signal upward', () => {
    manager.spawn(SPAWN, emit);

    pty().emitExit(137, 9);

    expect(sent.at(-1)).toEqual({
      type: 'exit',
      sessionId: 'hero-refresh',
      exitCode: 137,
      signal: 9,
    });
  });

  it('reports an exit exactly once, however many times the event fires', () => {
    manager.spawn(SPAWN, emit);

    pty().emitExit(0);
    pty().emitExit(0);

    // Story 093 promises exit lands after the final data flush. A second exit
    // would land after nothing.
    expect(sent.filter((message) => message.type === 'exit')).toHaveLength(1);
  });

  it('emits every pending data message before the exit', () => {
    manager.spawn(SPAWN, emit);

    pty().emitData(Buffer.from('the last thing it said\r\n'));
    pty().emitExit(1);

    const kinds = sent.map((message) => message.type);
    // Delivering exit early truncates the last output — usually the error.
    expect(kinds.indexOf('data')).toBeLessThan(kinds.lastIndexOf('exit'));
  });
});
