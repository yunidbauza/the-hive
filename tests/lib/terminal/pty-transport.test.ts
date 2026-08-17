import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHRASES } from '@lib/swarm/phrases';
import { toSgrIndexed } from '@lib/terminal/ansi';
import {
  createCloneTransport,
  createPtyTransport,
  reopenChannel,
  resetCloneChannel,
  requestSpawn,
  resetPtyChannels,
  sessionChannelState,
} from '@lib/terminal/pty-transport';

import type {
  DataEvent,
  ExitEvent,
  SessionLostEvent,
} from '@shared/ipc-contract';

/**
 * `PtyTransport` against a stubbed bridge (story 094).
 *
 * The bridge is the only thing this module touches, so the stub *is* the world:
 * every assertion below is either "the right verb reached the bridge" or "the
 * right bytes reached the subscriber". Nothing here needs xterm, a store, or a
 * process.
 */

type DataCb = (event: DataEvent) => void;
type ExitCb = (event: ExitEvent) => void;
type LostCb = (event: SessionLostEvent) => void;

/** Every listener the transport registered, so a test can drive the channel. */
interface Bridge {
  spawn: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  data: Set<DataCb>;
  exit: Set<ExitCb>;
  lost: Set<LostCb>;
  /** Disposer calls, so "unsubscribes exactly one listener" is assertable. */
  disposals: number;
}

let bridge: Bridge;

function installBridge(): Bridge {
  const data = new Set<DataCb>();
  const exit = new Set<ExitCb>();
  const lost = new Set<LostCb>();
  const stub = {
    spawn: vi.fn(() => Promise.resolve()),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => Promise.resolve()),
    ack: vi.fn(),
    data,
    exit,
    lost,
    disposals: 0,
  } satisfies Bridge;

  const subscribe = <T>(set: Set<T>) => (cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
      stub.disposals += 1;
    };
  };

  (window as { hive?: unknown }).hive = {
    pty: {
      spawn: stub.spawn,
      write: stub.write,
      resize: stub.resize,
      kill: stub.kill,
      ack: stub.ack,
      onData: subscribe(data),
      onExit: subscribe(exit),
      onLost: subscribe(lost),
    },
  };

  return stub;
}

/** Push a live chunk as main would, with an explicit sequence number. */
function pushData(sessionId: string, chunk: string, seq: number): void {
  for (const cb of [...bridge.data]) cb({ sessionId, chunk, seq });
}

const dim = toSgrIndexed('dim');
const amber = toSgrIndexed('amber');
const red = toSgrIndexed('red');

beforeEach(() => {
  bridge = installBridge();
});

afterEach(() => {
  resetPtyChannels();
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

describe('PtyTransport — pass-throughs', () => {
  it('forwards write verbatim, tagged with the session id', () => {
    createPtyTransport('sess-a', 'apfm-web').write('');

    expect(bridge.write).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      data: '',
    });
  });

  it('forwards resize verbatim, tagged with the session id', () => {
    createPtyTransport('sess-a', 'apfm-web').resize(120, 40);

    expect(bridge.resize).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      cols: 120,
      rows: 40,
    });
  });
});

describe('PtyTransport — subscribe before spawn', () => {
  /**
   * The ordering bug this exists to prevent reproduces about once in twenty
   * runs and looks like a rendering glitch: a shell prints its prompt the
   * instant it starts, so a transport that awaited the spawn before
   * subscribing would race those first bytes and lose the prompt.
   *
   * Asserted as an *order*, not as a pair of facts, because both calls happen
   * either way — only the sequence distinguishes correct from broken.
   */
  it('registers the data subscription before requesting the spawn', () => {
    const order: string[] = [];
    bridge.spawn.mockImplementation(() => {
      order.push('spawn');
      return Promise.resolve();
    });

    const transport = createPtyTransport('sess-a', 'apfm-web');
    const originalAdd = bridge.data.add.bind(bridge.data);
    bridge.data.add = (cb: DataCb) => {
      order.push('subscribe');
      return originalAdd(cb);
    };

    transport.onData(() => {});

    expect(order).toEqual(['subscribe', 'spawn']);
  });

  it('spawns with the project id and a conventional default geometry', () => {
    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    expect(bridge.spawn).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      projectId: 'apfm-web',
      cols: 80,
      rows: 24,
    });
  });

  it('spawns once for two subscribers on one entity, and feeds both', () => {
    // A per-subscriber spawn would fork a second `claude` in the same
    // repository — a data-loss bug wearing a rendering bug's clothes.
    const first: string[] = [];
    const second: string[] = [];

    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => first.push(chunk));
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => second.push(chunk));

    pushData('sess-a', 'hello', 1);

    expect(bridge.spawn).toHaveBeenCalledTimes(1);
    expect(first).toContain('hello');
    expect(second).toContain('hello');
  });

  it('ignores chunks belonging to another session', () => {
    const chunks: string[] = [];
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => chunks.push(chunk));

    pushData('sess-b', 'not yours', 1);

    expect(chunks).toEqual([]);
  });
});

describe('PtyTransport — the disposer', () => {
  it('removes exactly one listener and does not kill the PTY', () => {
    /**
     * Unmounting happens on every tab switch. A disposer that killed the
     * process would end a running agent because the user looked at something
     * else — the single most destructive thing this file could get wrong.
     */
    const transport = createPtyTransport('sess-a', 'apfm-web');
    const kept: string[] = [];
    const dropped: string[] = [];

    transport.onData((chunk) => kept.push(chunk));
    const dispose = transport.onData((chunk) => dropped.push(chunk));

    dispose();
    pushData('sess-a', 'after', 1);

    expect(kept).toContain('after');
    expect(dropped).toEqual([]);
    expect(bridge.kill).not.toHaveBeenCalled();
  });

  it('keeps buffering while nothing is subscribed, and replays on return', () => {
    // "Switch away for thirty seconds and back shows what happened while away."
    const transport = createPtyTransport('sess-a', 'apfm-web');
    const dispose = transport.onData(() => {});
    dispose();

    pushData('sess-a', 'while-away', 1);

    const seen: string[] = [];
    transport.onData((chunk) => seen.push(chunk));

    expect(seen.join('')).toContain('while-away');
  });

  it('does not respawn when a surface remounts', () => {
    const transport = createPtyTransport('sess-a', 'apfm-web');
    transport.onData(() => {})();
    transport.onData(() => {});

    expect(bridge.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('PtyTransport — replay ordering', () => {
  it('delivers the buffered transcript before any live chunk', () => {
    const transport = createPtyTransport('sess-a', 'apfm-web');
    transport.onData(() => {});
    pushData('sess-a', 'first', 1);
    pushData('sess-a', 'second', 2);

    const seen: string[] = [];
    transport.onData((chunk) => seen.push(chunk));
    pushData('sess-a', 'third', 3);

    /**
     * The replay arrives as one chunk, synchronously, ahead of the live one.
     * An asynchronous replay — fetching the host's buffer over IPC — would
     * interleave with whatever arrived meanwhile and shuffle the transcript.
     */
    expect(seen).toEqual(['firstsecond', 'third']);
  });

  it('bounds the replay buffer instead of growing without limit', () => {
    /**
     * A session can run for hours. Without the cap the renderer would hold
     * every byte a `pnpm build` ever emitted, per session, for the lifetime of
     * the app — and the cap is only real if the oldest chunks are actually
     * evicted rather than merely counted.
     */
    const transport = createPtyTransport('sess-a', 'apfm-web');
    transport.onData(() => {});

    const chunk = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 8; index += 1) {
      pushData('sess-a', chunk, index + 1);
    }
    pushData('sess-a', 'NEWEST', 9);

    const seen: string[] = [];
    transport.onData((replayed) => seen.push(replayed));
    const replay = seen.join('');

    // 8 × 64 KiB is past the 256 KiB budget, so the front is gone — but the
    // most recent output, which is what a returning user reads, is not.
    expect(replay.length).toBeLessThan(8 * 64 * 1024);
    expect(replay).toContain('NEWEST');
  });
});

describe('PtyTransport — flow control', () => {
  it('acks only when the consumer reports the chunk parsed', () => {
    /**
     * Story 093's flow control is meaningless without this, and worse than
     * meaningless if it fires early: acking on arrival measures the IPC
     * channel, not whether the terminal is keeping up.
     */
    let report: (() => void) | undefined;
    createPtyTransport('sess-a', 'apfm-web').onData((_chunk, parsed) => {
      report = parsed;
    });

    pushData('sess-a', 'output', 7);
    expect(bridge.ack).not.toHaveBeenCalled();

    report?.();
    expect(bridge.ack).toHaveBeenCalledWith({ sessionId: 'sess-a', seq: 7 });
  });

  it('offers no ack for lines it generated itself', () => {
    // A lifecycle notice never crossed the IPC boundary, so there is no
    // outstanding batch to release and acking one would corrupt the window.
    const reports: (undefined | (() => void))[] = [];
    createPtyTransport('sess-a', 'apfm-web').onData((_chunk, parsed) => {
      reports.push(parsed);
    });

    for (const cb of [...bridge.exit]) {
      cb({ sessionId: 'sess-a', exitCode: 0 });
    }

    expect(reports.at(-1)).toBeUndefined();
  });
});

describe('PtyTransport — lifecycle lines', () => {
  function transcriptAfter(drive: () => void): string {
    const seen: string[] = [];
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => seen.push(chunk));
    drive();
    return seen.join('');
  }

  it('renders a clean exit dim', () => {
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });
    });

    expect(text).toContain('── session exited ──');
    expect(text).toContain(dim);
    expect(text).not.toContain(amber);
  });

  it('renders a non-zero exit in amber, with the code', () => {
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 130 });
    });

    /**
     * The code is asserted, the swarm half is not: it is drawn from a pool and
     * pinning it here would make this test a coin flip. What matters is that
     * the diagnostic half survives the decoration.
     */
    expect(text).toContain('session exited (code 130)');
    expect(text).toContain(amber);
  });

  it('names the signal rather than printing its number', () => {
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.exit]) {
        cb({ sessionId: 'sess-a', exitCode: 0, signal: 15 });
      }
    });

    // `node-pty` reports 15; a user reads SIGTERM.
    expect(text).toContain('── session terminated (SIGTERM) ──');
  });

  it('treats signal 0 as no signal at all', () => {
    /**
     * Regression, and it was found by the desktop e2e rather than here.
     * `node-pty` reports `signal: 0` on an ordinary exit — not `undefined` —
     * so a check for `undefined` alone described every clean exit as
     * `session terminated (signal 0)`.
     */
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.exit]) {
        cb({ sessionId: 'sess-a', exitCode: 3, signal: 0 });
      }
    });

    expect(text).toContain('session exited (code 3)');
    expect(text).not.toContain('terminated');
  });

  it('renders a lost host in red', () => {
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.lost]) {
        cb({ sessionId: 'sess-a', reason: 'host-crashed' });
      }
    });

    expect(text).toContain('session lost (pty host crashed)');
    expect(text).toContain(red);
  });

  /**
   * The regression this change came closest to shipping.
   *
   * The lifecycle notices used to be module-level `const`s. Appending a drawn
   * phrase to one of those would call `pickPhrase` exactly once — when the
   * bundle was first imported — and every crash for the rest of the process
   * would then read identically. It would look correct in review, look correct
   * on the first crash, and only be wrong on the second.
   *
   * `Math.random` is walked rather than fixed so a frozen phrase fails loudly
   * instead of occasionally colliding.
   */
  it('draws a fresh phrase for each failure, not one per process', () => {
    /**
     * The regression this change came closest to shipping.
     *
     * The lifecycle notices used to be module-level `const`s. Appending a drawn
     * phrase to one of those would call `pickPhrase` exactly once — when the
     * bundle was first imported — and every failure for the rest of the
     * process would then read identically. It would look correct in review,
     * look correct on the first crash, and only be wrong on the second.
     *
     * The rng is pinned to a different index either side of the reopen, so a
     * frozen phrase cannot satisfy both halves and the test cannot pass by
     * coincidence.
     */
    const pool = PHRASES['failed.sessionExit'];
    const exitOnce = () => {
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 1 });
    };

    vi.spyOn(Math, 'random').mockReturnValue(0);
    transcriptAfter(exitOnce);

    reopenChannel('sess-a');

    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const text = transcriptAfter(exitOnce);

    const present = pool.filter((candidate) => text.includes(candidate));

    expect(present).toHaveLength(2);
  });

  it('reports an output gap when a sequence number is skipped', () => {
    const text = transcriptAfter(() => {
      pushData('sess-a', 'one', 1);
      pushData('sess-a', 'three', 3);
    });

    expect(text).toContain('── output gap detected ──');
    // The surviving output is still shown — a gap notice replaces nothing.
    expect(text).toContain('one');
    expect(text).toContain('three');
  });

  it('stays silent while sequence numbers are contiguous', () => {
    const text = transcriptAfter(() => {
      pushData('sess-a', 'one', 1);
      pushData('sess-a', 'two', 2);
      pushData('sess-a', 'three', 3);
    });

    expect(text).not.toContain('output gap');
  });

  it('starts every notice on a fresh line', () => {
    // A pty's last output routinely ends mid-line — a prompt, a progress bar.
    const text = transcriptAfter(() => {
      pushData('sess-a', '$ ', 1);
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });
    });

    expect(text).toContain('$ \r\n');
  });

  it('reports a refused spawn instead of showing an empty terminal', async () => {
    bridge.spawn.mockRejectedValueOnce(
      new Error('cannot start a session in "ghost": it is not mapped'),
    );

    const seen: string[] = [];
    createPtyTransport('ghost-sess', 'ghost').onData((chunk) => seen.push(chunk));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    expect(seen.join('')).toContain('it is not mapped');
    expect(seen.join('')).toContain(red);
  });

  it('says nothing more once the session has closed', () => {
    const text = transcriptAfter(() => {
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });
      for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 1 });
      pushData('sess-a', 'zombie output', 9);
    });

    expect(text).not.toContain('code 1');
    expect(text).not.toContain('zombie output');
  });
});

describe('sessionChannelState', () => {
  /**
   * The question `session-input.ts` asks before writing (story 097).
   *
   * `isLiveTerminal` answers "should a PTY back this surface?" — a fact about
   * the target and the build. This answers "is there a process to write to
   * right now", which is a fact about the world, and only the channel map
   * knows it.
   */
  it('is none for an entity that has never had a surface', () => {
    expect(sessionChannelState('never-opened')).toBe('none');
  });

  it('is live once a transport has requested a spawn', () => {
    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    expect(sessionChannelState('sess-a')).toBe('live');
  });

  it('is exited after the process ends', () => {
    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });

    expect(sessionChannelState('sess-a')).toBe('exited');
  });

  it('is exited after the host is lost, not live', () => {
    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    for (const cb of [...bridge.lost]) {
      cb({ sessionId: 'sess-a', reason: 'host-crashed' });
    }

    expect(sessionChannelState('sess-a')).toBe('exited');
  });
});

describe('reopenChannel', () => {
  it('lets a restarted entity receive data again', () => {
    const seen: string[] = [];
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => seen.push(chunk));
    for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });

    reopenChannel('sess-a');
    pushData('sess-a', 'from the new generation', 1);

    // Without the reopen the channel stays latched closed and every chunk the
    // new process produces is dropped.
    expect(seen.join('')).toContain('from the new generation');
    expect(sessionChannelState('sess-a')).toBe('none');
  });

  it('does not report a gap on the new generation’s first chunk', () => {
    const seen: string[] = [];
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => seen.push(chunk));
    pushData('sess-a', 'first', 1);
    pushData('sess-a', 'second', 2);
    for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });

    reopenChannel('sess-a');
    // Main's sequence counter restarts at 0 for each new session id, so a
    // retained lastSeq would make this look like a lost batch.
    pushData('sess-a', 'fresh', 1);

    expect(seen.join('')).not.toContain('output gap detected');
  });

  it('is a no-op for an entity that never had a channel', () => {
    expect(() => reopenChannel('never-seen')).not.toThrow();
  });
});

describe('requestSpawn', () => {
  it('asks main exactly once, however many callers ask', async () => {
    await Promise.all([
      requestSpawn('sess-a', 'apfm-web'),
      requestSpawn('sess-a', 'apfm-web'),
    ]);

    expect(bridge.spawn).toHaveBeenCalledTimes(1);
  });

  it('carries the task on the spawn request', async () => {
    await requestSpawn('sess-a', 'apfm-web', { task: 'fix the hero' });

    expect(bridge.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'fix the hero' }),
    );
  });

  it('omits an empty task, so the picker can start a task-less session', async () => {
    /**
     * The picker passes `''` on purpose — it starts a session and the first
     * message gives it its job (story 044). Sent on the wire, main's guard
     * rejects it and every picker-started session fails to spawn.
     */
    await requestSpawn('sess-a', 'apfm-web', { task: '' });

    expect(bridge.spawn.mock.calls[0]?.[0]).not.toHaveProperty('task');
  });

  it('omits a whitespace-only task for the same reason', async () => {
    await requestSpawn('sess-a', 'apfm-web', { task: '   ' });

    expect(bridge.spawn.mock.calls[0]?.[0]).not.toHaveProperty('task');
  });

  it('flattens a multi-line task, which main would otherwise refuse', async () => {
    /**
     * A regression guard with a specific failure behind it.
     *
     * Once `Shift+Enter` reached the console a task could genuinely contain a
     * line break, and main's `assertText` rejects **every** control character —
     * `\n` included — refusing the whole spawn. Because `spawnSession` adds the
     * session to the store synchronously and this call resolves later, the user
     * was left looking at a session row whose process never started, next to
     * `spawn.task: control characters are not allowed` in red.
     *
     * Flattened on this side rather than by loosening the guard: a task crosses
     * the IPC boundary as a *value*, not as text at a prompt, so it has no use
     * for the line structure `sendToSession` now preserves.
     */
    await requestSpawn('sess-a', 'apfm-web', {
      task: 'fix the login\nand the signup flow',
    });

    expect(bridge.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'fix the login and the signup flow' }),
    );
  });

  it('strips a control character from a task rather than failing the spawn', async () => {
    // Main refuses the whole spawn on a stray byte; dropping it sends the task
    // the user meant, which is the better outcome for a paste that carries one.
    // Written by code point so this file stays free of literal control bytes.
    await requestSpawn('sess-a', 'apfm-web', { task: 'tidy\u0007 up' });

    expect(bridge.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'tidy up' }),
    );
  });

  it('resolves rather than throwing when there is no bridge', async () => {
    delete (window as { hive?: unknown }).hive;

    // `spawnSession` calls this fire-and-forget after creating the entity; a
    // synchronous throw would take the whole action down.
    await expect(requestSpawn('sess-a', 'apfm-web')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('omits the task key entirely when there is none', async () => {
    // Not `task: undefined` — the IPC guard rejects unexpected keys, and an
    // explicit undefined survives the structured clone as an own property.
    await requestSpawn('sess-a', 'apfm-web');

    expect(bridge.spawn.mock.calls[0]?.[0]).not.toHaveProperty('task');
  });

  it("resolves with main's refusal rather than throwing", async () => {
    bridge.spawn.mockRejectedValueOnce(
      new Error('apfm-web is not mapped — add it to /tmp/hive.json'),
    );

    await expect(requestSpawn('sess-a', 'apfm-web')).resolves.toEqual({
      ok: false,
      reason: 'apfm-web is not mapped — add it to /tmp/hive.json',
    });
  });

  it('writes the refusal into the terminal as well as returning it', async () => {
    bridge.spawn.mockRejectedValueOnce(new Error('session limit reached (12)'));

    const seen: string[] = [];
    await requestSpawn('sess-a', 'apfm-web');
    createPtyTransport('sess-a', 'apfm-web').onData((chunk) => seen.push(chunk));

    expect(seen.join('')).toContain('session limit reached (12)');
  });

  it('hands a mounting surface the same request, so nothing spawns twice', async () => {
    const pending = requestSpawn('sess-a', 'apfm-web');
    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    await pending;

    expect(bridge.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not re-request for a surface that mounts after an exit', async () => {
    await requestSpawn('sess-a', 'apfm-web');
    for (const cb of [...bridge.exit]) cb({ sessionId: 'sess-a', exitCode: 0 });

    createPtyTransport('sess-a', 'apfm-web').onData(() => {});

    // Attach-never-respawn: a tab switch past a finished session must not
    // silently start it working again (story 094).
    expect(bridge.spawn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The clone transport (story 102).
 *
 * Everything that carries bytes is the session path's, already covered above.
 * What is worth its own tests is the single difference — it never spawns — and
 * the consequence that makes the story work: keystrokes reach `git`, so a
 * credential prompt is answerable.
 */
describe('createCloneTransport', () => {
  const CLONE_ID = 'hive.clone';

  it('never spawns, because main already started git', () => {
    const transport = createCloneTransport();

    transport.onData(() => {});

    expect(bridge.spawn).not.toHaveBeenCalled();
  });

  it('does not spawn even across a remount', () => {
    const transport = createCloneTransport();

    transport.onData(() => {})();
    transport.onData(() => {})();

    expect(bridge.spawn).not.toHaveBeenCalled();
  });

  it('writes keystrokes under the clone entity id', () => {
    createCloneTransport().write('hunter2\r');

    expect(bridge.write).toHaveBeenCalledWith({
      sessionId: CLONE_ID,
      data: 'hunter2\r',
    });
  });

  it('forwards resize under the clone entity id', () => {
    createCloneTransport().resize(120, 40);

    expect(bridge.resize).toHaveBeenCalledWith({
      sessionId: CLONE_ID,
      cols: 120,
      rows: 40,
    });
  });

  it('delivers git output to its subscriber', () => {
    const chunks: string[] = [];
    createCloneTransport().onData((chunk) => chunks.push(chunk));

    pushData(CLONE_ID, "Cloning into 'the-hive'...\r\n", 0);

    expect(chunks.join('')).toContain("Cloning into 'the-hive'...");
  });

  it('replays what arrived before a late subscriber mounted', () => {
    const transport = createCloneTransport();
    transport.onData(() => {})();

    pushData(CLONE_ID, 'remote: Counting objects\r\n', 0);

    const chunks: string[] = [];
    transport.onData((chunk) => chunks.push(chunk));

    expect(chunks.join('')).toContain('remote: Counting objects');
  });

  it('unsubscribes without killing the process', () => {
    const transport = createCloneTransport();

    transport.onData(() => {})();

    expect(bridge.kill).not.toHaveBeenCalled();
  });
});

/**
 * Every clone reuses one entity id, so its channel has to be startable again.
 *
 * A session's channel is sticky on purpose — `closed` is a one-way latch and
 * the buffer survives a remount — and both are wrong here. Without a reset the
 * *second* clone of a session renders nothing at all: `onData` returns early on
 * a channel the first clone closed, and the terminal sits empty while git runs
 * perfectly well underneath it.
 */
describe('resetCloneChannel', () => {
  const CLONE_ID = 'hive.clone';

  it('lets a second clone deliver output after the first exited', () => {
    const transport = createCloneTransport();
    const first: string[] = [];
    transport.onData((chunk) => first.push(chunk));

    pushData(CLONE_ID, 'first clone\r\n', 0);
    for (const cb of [...bridge.exit]) {
      cb({ sessionId: CLONE_ID, exitCode: 0, signal: 0 });
    }

    // Without the reset this chunk is dropped and the terminal stays empty.
    resetCloneChannel();

    const second: string[] = [];
    const stop = transport.onData((chunk) => second.push(chunk));
    pushData(CLONE_ID, 'second clone\r\n', 0);
    stop();

    expect(second.join('')).toContain('second clone');
  });

  it('drops the previous clone transcript rather than replaying it', () => {
    const transport = createCloneTransport();
    transport.onData(() => {})();
    pushData(CLONE_ID, 'first clone\r\n', 0);

    resetCloneChannel();

    const replayed: string[] = [];
    transport.onData((chunk) => replayed.push(chunk));

    expect(replayed.join('')).not.toContain('first clone');
  });

  it('is safe before any clone has run', () => {
    expect(() => resetCloneChannel()).not.toThrow();
  });
});
