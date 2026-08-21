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
 * ## Both endings, not just one
 *
 * The per-tab `kill` path is covered first and in most detail, because a leak
 * on quit is bounded by the app exiting while a leak on *tab close* accumulates
 * all day — one stray tree per session the user opened and closed, which is the
 * reported symptom. But `killAll` gets an escaped descendant too: it shares
 * `teardown` with `kill` today, and a group that only ever exercised one caller
 * would let a divergence through while claiming to cover both.
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
     * is the guard against that. (`startEscapedGrandchild` has already refused
     * to hand back a non-numeric pgid, so this comparison cannot pass vacuously.)
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

  it('killAll sweeps an escaped descendant too', async (context) => {
    /**
     * The quit path, with the shape `lifecycle`'s version cannot produce.
     *
     * `lifecycle › killAll leaves no descendant of any session` uses
     * `startGrandchild` (`set +m`), so its children sit in the shell's own
     * group and the group kill alone satisfies it. Without this, a regression
     * that broke the sweep *only* on the `killAll` path would go uncaught while
     * the docs claimed both endings were covered.
     */
    const sessions = [];
    const children = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await context.ready(context.open());
      const child = await startEscapedGrandchild(
        session,
        context.scratch,
        `quit-escaped-${i}`,
      );
      assert.notEqual(
        child.pgid,
        pgidOf(session.pid),
        `session ${i}'s job did not escape its shell's process group`,
      );
      sessions.push(session);
      children.push(child);
    }

    await context.manager.killAll();

    for (const child of children) {
      await waitFor(() => !isAlive(child.pid), {
        timeout: 10_000,
        message: `escaped descendant pid ${child.pid} to be gone after killAll`,
      });
    }
  });

  it('a descendant two levels below the escaped job is swept', async (context) => {
    /**
     * The real tree has depth, and depth is where a sweep gets it wrong.
     *
     * `claude` → `bun run …` → `bun server.ts` is two levels under the shell,
     * and each level can sit in a process group of its own. A walk that stops
     * at the first generation finds the middle node, group-kills *its* group,
     * and leaves the leaf behind — still running, holding memory and whatever
     * single-consumer resource it claimed, with nothing pointing at it.
     *
     * ## Why `set -m` appears twice
     *
     * Once in the line typed at the pty, which puts the **script** in its own
     * group, and again *inside* the script, which puts the **leaf** in a third.
     * The inner one is the whole test: a script runs non-interactively, so job
     * control is off by default and the leaf would otherwise inherit the
     * script's group — where the sweep's group-kill of the middle node reaches
     * it for free, and the assertion passes against a walk that never recursed.
     * That is exactly what the first version of this test did, and it is why
     * the two pgids are asserted distinct below rather than assumed.
     *
     * The middle node deliberately does **not** exit. A parent that dies before
     * teardown snapshots the tree has already reparented its child to launchd,
     * taking the `ppid` linkage with it — that is a limit the design states
     * plainly, not a property to assert against.
     */
    const session = await context.ready(context.open());
    const shellPgid = pgidOf(session.pid);
    const scriptPidFile = join(context.scratch, 'middle.pid');
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
      'set -m\n' +
        'trap "" HUP\n' +
        `echo $$ > "${scriptPidFile}"\n` +
        'sh -c \'trap "" HUP; echo $$ > "' +
        leafPidFile +
        '"; exec sleep 100\' &\n' +
        'exec sleep 100\n',
      'utf8',
    );

    session.send(`set -m; sh "${script}" &`);

    const readPid = (file) =>
      waitFor(
        () => {
          try {
            const text = readFileSync(file, 'utf8').trim();
            return /^\d+$/.test(text) ? Number(text) : null;
          } catch {
            // Not written yet — `waitFor` treats a falsy answer as "keep polling".
            return null;
          }
        },
        { message: `${file} to be written` },
      );

    const scriptPid = await readPid(scriptPidFile);
    const leafPid = await readPid(leafPidFile);

    await waitFor(() => isAlive(leafPid), { message: `leaf ${leafPid} to be running` });

    const scriptPgid = pgidOf(scriptPid);
    const leafPgid = pgidOf(leafPid);

    assert.equal(typeof scriptPgid, 'number', 'could not read the middle pgid');
    assert.equal(typeof leafPgid, 'number', 'could not read the leaf pgid');

    assert.notEqual(
      scriptPgid,
      shellPgid,
      'the middle node did not escape the shell’s process group',
    );

    /**
     * The assertion that makes this a depth test.
     *
     * Without it the leaf could be sharing the middle's group, and killing the
     * middle's group would take it out whether or not the walk ever recursed.
     */
    assert.notEqual(
      leafPgid,
      scriptPgid,
      `the leaf (pgid ${leafPgid}) shares the middle node's group (${scriptPgid}), ` +
        'so a group kill of the middle reaches it for free and this test cannot ' +
        'distinguish a recursive walk from a first-generation one',
    );
    assert.notEqual(leafPgid, shellPgid, 'the leaf shares the shell’s process group');

    session.kill();

    await waitFor(() => !isAlive(leafPid), {
      timeout: 10_000,
      message:
        `the leaf descendant pid ${leafPid} (pgid ${leafPgid}) to be gone after ` +
        'kill — a survivor here means the walk stopped short of it',
    });
    await waitFor(() => !isAlive(scriptPid), {
      timeout: 10_000,
      message: `the middle descendant pid ${scriptPid} to be gone after kill`,
    });
  });
});
