import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert,
  describe,
  isAlive,
  it,
  pgidOf,
  startEscapedGrandchild,
  waitFor,
} from './harness.mjs';

/**
 * Descendant sweep (HIVE-72), against the shape that actually escapes.
 *
 * ## The question this group exists to answer
 *
 * "We are running several sessions and there are stray processes eating CPU —
 * is the app leaking them?" That question was answered by *reading* the
 * teardown, which is not an answer. This group answers it by killing real
 * sessions and counting what survives.
 *
 * ## Why the existing no-descendant assertions were not enough
 *
 * `lifecycle › killAll leaves no descendant of any session` and
 * `signals › the process group is killable, leaving no descendant` both build
 * their grandchild with `startGrandchild`, which runs `set +m`. Job control off
 * means `&` leaves the job **in the shell's own process group**, so both pass
 * against an implementation that does nothing but `kill(-shellPid)`. They are
 * deliberately scoped that way — they isolate "is the group signalled?" — but
 * it leaves the sweep itself uncovered.
 *
 * The processes that motivated HIVE-72 are the ones in a group of their *own*:
 * an agent's long-lived children, an MCP server a `claude` started. Those
 * survive a group kill by construction. Only the `ps`-walk in
 * `process-tree.ts` reaches them, and until now nothing failed if it stopped
 * reaching them.
 *
 * ## The per-tab path, not just quit
 *
 * These drive `manager.kill(sessionId)` — closing one tab — rather than
 * `killAll`. A leak on quit is bounded by the app exiting; a leak on *tab
 * close* accumulates all day, one stray tree per session the user opened and
 * closed, which is exactly the reported symptom.
 */
describe('descendants', () => {
  it('a job that escaped the process group is still swept on kill', async (context) => {
    const session = await context.ready(context.open());
    const shellPgid = pgidOf(session.pid);

    const child = await startEscapedGrandchild(session, context.scratch, 'escaped');

    /**
     * Prove the premise before trusting the conclusion.
     *
     * If the shell decided it was non-interactive, `&` would have left the job
     * in the shell's group and the kill below would succeed for a reason that
     * has nothing to do with the sweep — a green test asserting nothing. This
     * is the guard against that.
     */
    assert.notEqual(
      child.pgid,
      shellPgid,
      `the backgrounded job did not escape: pgid ${child.pgid} is the shell's own. ` +
        'Job control was off, so this test degenerates into the group-kill case ' +
        'that lifecycle/signals already cover, and proves nothing about the sweep.',
    );

    session.kill();

    await waitFor(() => !isAlive(child.pid), {
      timeout: 10_000,
      message:
        `the escaped descendant pid ${child.pid} (pgid ${child.pgid}, shell pgid ` +
        `${shellPgid}) to be gone after kill — a survivor here is the leak ` +
        'HIVE-72 exists to prevent',
    });
  });

  it('closing five sessions one at a time leaves no escaped descendant', async (context) => {
    /**
     * The reported shape: several sessions open at once, closed individually.
     *
     * One at a time rather than `killAll`, because that is what a user does to
     * a tab, and because each `kill` snapshots and sweeps its *own* tree — five
     * concurrent teardowns are five chances for one to sweep a snapshot taken
     * before another session's job existed.
     */
    const sessions = [];
    for (let i = 0; i < 5; i += 1) {
      sessions.push(await context.ready(context.open()));
    }

    const children = [];
    for (const [index, session] of sessions.entries()) {
      const child = await startEscapedGrandchild(
        session,
        context.scratch,
        `escaped-${index}`,
      );
      assert.notEqual(
        child.pgid,
        pgidOf(session.pid),
        `session ${index}'s job did not escape its shell's process group`,
      );
      children.push(child);
    }

    for (const session of sessions) session.kill();

    const survivors = [];
    for (const child of children) {
      try {
        await waitFor(() => !isAlive(child.pid), { timeout: 10_000 });
      } catch {
        survivors.push(child.pid);
      }
    }

    assert.deepEqual(
      survivors,
      [],
      `${survivors.length} of ${children.length} escaped descendants outlived ` +
        `their session: ${survivors.join(', ')}`,
    );
  });

  it('a descendant two levels below the escaped job is swept', async (context) => {
    /**
     * The real tree has depth, and depth is where a sweep gets it wrong.
     *
     * `claude` → `bun run …` → `bun server.ts` is three levels under the shell,
     * and the middle one exits on its own while the leaf keeps running. A walk
     * that stops at the first generation, or that drops a node whose parent has
     * already been reparented, leaves the leaf behind — holding memory and
     * whatever single-consumer resource it claimed, with nothing pointing at it.
     */
    const session = await context.ready(context.open());
    const leafPidFile = join(context.scratch, 'leaf.pid');
    const script = join(context.scratch, 'deep.sh');

    /**
     * A script file rather than a nested `sh -c` string.
     *
     * Three levels of shell quoting inside a line typed into a pty is a way to
     * debug quoting rather than teardown; the file has one level and reads as
     * what it is.
     */
    writeFileSync(
      script,
      'trap "" HUP\n' +
        'sh -c \'trap "" HUP; echo $$ > "' +
        leafPidFile +
        '"; exec sleep 100\' &\n' +
        'exec sleep 100\n',
      'utf8',
    );

    const middle = await startEscapedGrandchild(session, context.scratch, 'middle');
    assert.notEqual(middle.pgid, pgidOf(session.pid));

    session.send(`set -m; sh "${script}" &`);

    const leafPid = await waitFor(
      () => {
        try {
          const text = readFileSync(leafPidFile, 'utf8').trim();
          return /^\d+$/.test(text) ? Number(text) : null;
        } catch {
          // Not written yet — `waitFor` treats a falsy answer as "keep polling".
          return null;
        }
      },
      { message: 'the leaf process to record its pid' },
    );

    await waitFor(() => isAlive(leafPid), { message: `leaf ${leafPid} to be running` });

    session.kill();

    await waitFor(() => !isAlive(leafPid), {
      timeout: 10_000,
      message: `the leaf descendant pid ${leafPid} to be gone after kill`,
    });
  });
});
