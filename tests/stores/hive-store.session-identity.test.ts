import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isSession } from '@/types/entity';

import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { useHiveStore } from '@stores/hive-store';

/**
 * What main is told, so the pin survives a quit (HIVE-107).
 *
 * Mocked rather than driven through the bridge for the reason
 * `hive-store.refresh-prs.test.ts` gives about its own note: what is under test
 * is *when* the store speaks and *what it says*, not the IPC underneath.
 */
const noteSessionTicket = vi.fn();

vi.mock('@lib/session-history', () => ({
  noteSessionTicket: (request: unknown) => noteSessionTicket(request),
  noteSessionPr: vi.fn(),
  readSessionHistory: vi.fn(),
}));

/**
 * What a session is *called*, and what branch it is *on* (HIVE-78).
 *
 * Both used to be assertions the app made up: the branch was
 * `` `feat/${id}` ``, and the name was whatever Claude's terminal title
 * happened to say. Now the branch is observed, and the name can be claimed by
 * the app when the user says which ticket they are working.
 */

/** A session with a project and no ticket — the PROJECTS-tab spawn. */
function spawn(): string {
  return useHiveStore.getState().spawnSession('nova-web');
}

function sessionAt(id: string) {
  const entity = useHiveStore.getState().entities[id];
  if (!entity || !isSession(entity)) throw new Error(`expected a session at ${id}`);
  return entity;
}

beforeEach(() => {
  useHiveStore.getState().reset();
  noteSessionTicket.mockReset();
});

describe('setSessionBranch', () => {
  it('records the branch and the directory it was read in', () => {
    const id = spawn();

    useHiveStore
      .getState()
      .setSessionBranch(id, 'feat/incorp-332', '/repo/.claude/worktrees/x');

    expect(sessionAt(id).branch).toBe('feat/incorp-332');
    expect(sessionAt(id).cwd).toBe('/repo/.claude/worktrees/x');
  });

  it('lands a null branch as an absent field, never the string', () => {
    /**
     * The wire needs `null` because a typed event cannot conditionally omit a
     * field; the store does not. Two spellings of "there is no branch" would
     * mean every surface handled both, and one of them would eventually render
     * the word `null` in the fleet table.
     */
    const id = spawn();

    useHiveStore.getState().setSessionBranch(id, null, '/repo');

    expect(sessionAt(id).branch).toBeUndefined();
    expect(sessionAt(id).cwd).toBe('/repo');
  });

  it('does not touch state when neither value moved', () => {
    // Identity matters: main already suppresses unchanged branches, so a no-op
    // write here would re-render every consumer of the entity map for nothing.
    const id = spawn();
    useHiveStore.getState().setSessionBranch(id, 'main', '/repo');
    const before = useHiveStore.getState().entities;

    useHiveStore.getState().setSessionBranch(id, 'main', '/repo');

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('writes when only the directory moved', () => {
    /**
     * Two worktrees can carry the same branch name. The explorer roots on the
     * directory, so this is a real change even though the branch string is
     * identical.
     */
    const id = spawn();
    useHiveStore.getState().setSessionBranch(id, 'main', '/repo/a');

    useHiveStore.getState().setSessionBranch(id, 'main', '/repo/b');

    expect(sessionAt(id).cwd).toBe('/repo/b');
  });

  it('leaves an unknown entity and an agent alone', () => {
    const before = useHiveStore.getState().entities;
    useHiveStore.getState().setSessionBranch('ghost', 'main', '/repo');

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('removes the key entirely when a branch is lost, not just its value', () => {
    /**
     * `'branch' in entity` must be false, which an explicit `branch: undefined`
     * would not satisfy — and that is what this first shipped as. A session
     * observed on a branch and then moved to a detached HEAD would otherwise
     * diverge under `toStrictEqual` from one nobody had ever looked at, which
     * is the key-for-key comparison the store's own snapshots rely on.
     */
    const id = spawn();
    useHiveStore.getState().setSessionBranch(id, 'feat/thing', '/repo');
    expect('branch' in sessionAt(id)).toBe(true);

    useHiveStore.getState().setSessionBranch(id, null, '/repo');

    expect('branch' in sessionAt(id)).toBe(false);
    expect(sessionAt(id).cwd).toBe('/repo');
  });
});

describe('the /status console command', () => {
  it('prints an em dash rather than the word undefined', () => {
    /**
     * The **fourth** branch surface, and the one that survived the first pass
     * of HIVE-78 — it builds a string instead of rendering a component, so it
     * was not caught by converting the three that call `branchLabel()`.
     * Interpolating the now-optional field raw printed a literal `undefined`
     * for every session whose branch had not been observed yet.
     */
    spawn();

    useHiveStore.getState().runOrchCommand(parseCommand('status'));

    const transcript = useHiveStore
      .getState()
      .orchLines.map((entry) => entry.text)
      .join('\n');

    expect(transcript).not.toContain('undefined');
    expect(transcript).toContain('—');
  });

  it('prints the real branch once observed', () => {
    const id = spawn();
    useHiveStore.getState().setSessionBranch(id, 'feat/observed', '/repo');

    useHiveStore.getState().runOrchCommand(parseCommand('status'));

    const transcript = useHiveStore
      .getState()
      .orchLines.map((entry) => entry.text)
      .join('\n');

    expect(transcript).toContain('feat/observed');
  });
});

describe('setSessionTicket', () => {
  it('associates the session and pins its name to the key', () => {
    const id = spawn();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    expect(sessionAt(id).ticket).toBe('HIVE-73');
    expect(sessionAt(id).name).toBe('HIVE-73');
    expect(sessionAt(id).namePinned).toBe(true);
  });

  it('associates without renaming when the key was inferred, not spoken', () => {
    /**
     * `{ source: 'branch' }` is the branch signal's whole difference from the
     * spoken one, and the reason it is safe to infer at all.
     *
     * Reading `HIVE-73` off a branch is right often enough to file the session
     * on the right WORK card — `facetsForTicket` matches on `ticket` and never
     * on the name, so the row appears — and not right enough to rewrite a name
     * the user has been reading, which a `git checkout` would otherwise be able
     * to do.
     */
    const id = spawn();
    const nameBefore = sessionAt(id).name;

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73', { source: 'branch' });

    expect(sessionAt(id).ticket).toBe('HIVE-73');
    expect(sessionAt(id).name).toBe(nameBefore);
    expect(sessionAt(id).namePinned).toBeUndefined();
  });

  it('leaves an agent-chosen name pinned by nobody', () => {
    /**
     * The case the option exists for (HIVE-108): Claude titled the session
     * after the conversation actually running in it. A branch-inferred link
     * must not take that name away, and must not pin it either — an unpinned
     * name stays the agent's to change on its next repaint.
     */
    const id = spawn();
    useHiveStore.getState().renameSession(id, 'ledger-spike');

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73', { source: 'branch' });

    expect(sessionAt(id).ticket).toBe('HIVE-73');
    expect(sessionAt(id).name).toBe('ledger-spike');
    expect(sessionAt(id).namePinned).toBeUndefined();

    /*
      And the name is still the user's to change afterwards. It is no longer the
      *agent's* to change: a row that already has a real name refuses a later
      title unless a person typed it, because Claude's own title is a guess about
      a turn hundreds of prompts after the one that named this row.
    */
    useHiveStore.getState().renameSession(id, 'ledger-spike-2', 'agent');
    expect(sessionAt(id).name).toBe('ledger-spike');

    useHiveStore.getState().renameSession(id, 'ledger-spike-2', 'rename');
    expect(sessionAt(id).name).toBe('ledger-spike-2');
  });

  it('tells main the association but no name when it chose none', () => {
    /**
     * Sending `name: undefined` would be main being told to forget the name it
     * has — the record survives a quit (HIVE-87, HIVE-107), and a silent link
     * changed no name, so it has nothing to say about one.
     */
    const id = spawn();
    noteSessionTicket.mockReset();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73', { source: 'branch' });

    /*
      Asserted on the *keys*, not with `toHaveBeenCalledWith`.

      `toHaveBeenCalledWith` uses `toEqual` semantics, which treat an own
      property whose value is `undefined` as absent — so it passes just as
      happily against `{ entityId, ticket, name: undefined }`. That is exactly
      the shape this test exists to rule out, since sending an explicit
      `undefined` name is main being told to forget the name it has. Keys are
      the only assertion that can actually fail here.
    */
    expect(noteSessionTicket).toHaveBeenCalledTimes(1);
    const [request] = noteSessionTicket.mock.calls[0]!;
    expect(Object.keys(request).sort()).toEqual(['entityId', 'ticket']);
    expect(request).toMatchObject({ entityId: id, ticket: 'HIVE-73' });
  });

  /**
   * The spoken key beats the inferred one — even though it arrives second.
   *
   * This is the ordering that actually happens, and the plain "already has a
   * ticket" refusal got it backwards. Main reads the branch **at spawn**, so a
   * session opened in a worktree still on `feat/hive-108-titles` is associated
   * before the user has typed a character. Under the old rule, typing
   * `/work-on HIVE-111` — the very spelling this work exists to support — was
   * then silently dropped, and because a branch link does not rename, nothing
   * on screen said why.
   */
  it('lets a spoken key replace one that was only inferred', () => {
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-108', { source: 'branch' });

    useHiveStore.getState().setSessionTicket(id, 'HIVE-111');

    expect(sessionAt(id).ticket).toBe('HIVE-111');
    expect(sessionAt(id).name).toBe('HIVE-111');
    expect(sessionAt(id).namePinned).toBe(true);
    // Promoted, so the next checkout cannot displace it again.
    expect(sessionAt(id).ticketInferred).toBeUndefined();
  });

  it('promotes an inferred key the user then says out loud', () => {
    // Same key, now spoken: the row should take the name and the pin, rather
    // than being refused as a no-op it looks like from the ticket alone.
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73', { source: 'branch' });

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    expect(sessionAt(id).name).toBe('HIVE-73');
    expect(sessionAt(id).namePinned).toBe(true);
    expect(sessionAt(id).ticketInferred).toBeUndefined();
  });

  it('does not let a branch displace anything, inferred or spoken', () => {
    // The weaker signal never wins a contest, in either direction.
    const spoken = spawn();
    useHiveStore.getState().setSessionTicket(spoken, 'HIVE-73');
    useHiveStore.getState().setSessionTicket(spoken, 'HIVE-99', { source: 'branch' });
    expect(sessionAt(spoken).ticket).toBe('HIVE-73');

    const inferred = spawn();
    useHiveStore.getState().setSessionTicket(inferred, 'HIVE-73', { source: 'branch' });
    useHiveStore.getState().setSessionTicket(inferred, 'HIVE-99', { source: 'branch' });
    expect(sessionAt(inferred).ticket).toBe('HIVE-73');
  });

  it('refuses a second spoken key, which is a change of mind', () => {
    /*
      Not the same case as displacing an inference. Both keys were claimed by
      the user, and the row would end up named for work that is not most of its
      own transcript — `/clear` is the tool for that, and it retires the row.
    */
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().setSessionTicket(id, 'HIVE-99');

    expect(sessionAt(id).ticket).toBe('HIVE-73');
    expect(sessionAt(id).name).toBe('HIVE-73');
  });

  it('still refuses a session that already has a ticket', () => {
    // The branch signal fires on every branch change, so this refusal is what
    // stops a checkout re-filing work that is already spoken for.
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().setSessionTicket(id, 'HIVE-99', { source: 'branch' });

    expect(sessionAt(id).ticket).toBe('HIVE-73');
    expect(sessionAt(id).name).toBe('HIVE-73');
  });

  it('de-duplicates against a session already named for the ticket', () => {
    const first = useHiveStore
      .getState()
      .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
    const second = spawn();

    useHiveStore.getState().setSessionTicket(second, 'HIVE-73');

    expect(sessionAt(first).name).toBe('HIVE-73');
    expect(sessionAt(second).name).toBe('HIVE-73-2');
  });

  /**
   * The name goes with the ticket, because main cannot work it out (HIVE-107).
   *
   * A mid-session rename is the app's own: Claude is never told, so it never
   * comes back on the title stream, so `readTitle` — main's only other source
   * of names — never sees it. Left unsent, the session history kept `sess-01` for a row
   * the user had been reading as `HIVE-73`, and the next launch restored the
   * id. And `ticketSessionName` de-duplicates against the whole fleet, so the
   * name is not something main could derive from the key either.
   */
  it('tells main the name it pinned, not just the ticket', () => {
    const id = spawn();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    expect(noteSessionTicket).toHaveBeenCalledWith({
      entityId: id,
      ticket: 'HIVE-73',
      name: 'HIVE-73',
    });
  });

  it('sends the de-duplicated name, which is the one on screen', () => {
    const first = spawn();
    const second = spawn();
    useHiveStore.getState().setSessionTicket(first, 'HIVE-73');
    noteSessionTicket.mockReset();

    useHiveStore.getState().setSessionTicket(second, 'HIVE-73');

    expect(noteSessionTicket).toHaveBeenCalledWith({
      entityId: second,
      ticket: 'HIVE-73',
      name: 'HIVE-73-2',
    });
  });

  /**
   * Sent from the action rather than beside it, so the two cannot disagree.
   *
   * The note used to be a second call in `use-session-status.ts`, made whether
   * or not this action accepted the association — so a refusal still wrote the
   * ticket into the session history, and next launch restored a row carrying
   * a key the store had declined to give it.
   */
  it('says nothing to main when it refuses the association', () => {
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');
    noteSessionTicket.mockReset();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-99');

    expect(noteSessionTicket).not.toHaveBeenCalled();
  });

  it('says nothing to main about a session that has ended', () => {
    const id = spawn();
    useHiveStore.getState().setSessionStatus(id, 'terminated');
    noteSessionTicket.mockReset();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    expect(noteSessionTicket).not.toHaveBeenCalled();
  });

  it('refuses a session that already has a ticket', () => {
    /**
     * Moving a session between tickets mid-conversation is a claim about work
     * that has already happened in it, and the row would end up carrying a name
     * that does not describe most of its own transcript. `/clear` is the honest
     * tool for that.
     */
    const id = useHiveStore
      .getState()
      .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');

    useHiveStore.getState().setSessionTicket(id, 'HIVE-99');

    expect(sessionAt(id).ticket).toBe('HIVE-73');
  });

  it('refuses a session that has ended', () => {
    // An ended row is history; naming it now would rewrite the record.
    const id = spawn();
    useHiveStore.getState().setSessionStatus(id, 'terminated');

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    expect(sessionAt(id).ticket).toBeUndefined();
  });

  it('records the association in the console transcript', () => {
    // The rename is something the app did on its own initiative, so it says so
    // where every other spawn and refusal is recorded.
    const id = spawn();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    const transcript = useHiveStore
      .getState()
      .orchLines.map((entry) => entry.text)
      .join('\n');
    expect(transcript).toContain('HIVE-73');
  });

  it('names the session by its new name in the console, never by id (HIVE-91)', () => {
    const id = spawn();

    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    const transcript = useHiveStore
      .getState()
      .orchLines.map((entry) => entry.text)
      .join('\n');
    expect(transcript).toContain(sessionAt(id).name);
    expect(transcript).not.toContain(id);
    // The generated name already carries the key, so the line says it once —
    // never `HIVE-73 is working HIVE-73`.
    expect(transcript).toContain('  renamed → HIVE-73');
    expect(transcript).not.toMatch(/HIVE-73.*HIVE-73/);
  });
});

describe('a pinned name outranks the agent', () => {
  it('ignores a title the agent reports afterwards', () => {
    /**
     * The reason `namePinned` exists at all. Claude repaints its title several
     * times a second, so a name assigned in the store and left undefended
     * survives about one frame — the user would see `HIVE-73` flick past and
     * `sess-01` come back.
     */
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().renameSession(id, 'sess-01');

    expect(sessionAt(id).name).toBe('HIVE-73');
  });

  it('still honours a rename on a session that was never pinned', () => {
    // HIVE-61's behaviour for every session the app has not named — now spelled
    // in the rail's own register (HIVE-108).
    const id = spawn();

    useHiveStore.getState().renameSession(id, 'fix the login bug');

    expect(sessionAt(id).name).toBe('fix-the-login-bug');
  });

  /**
   * What the pin defends is the **key**, not the whole name (HIVE-108, narrowed
   * by first-prompt naming).
   *
   * Refusing every title was right while the alternative was `sess-01`. The
   * alternative became a description of the work, and the ticket plus that
   * description beats either alone — `HIVE-1234-bug-fixing`.
   *
   * First-prompt naming keeps that machinery and narrows **who may reach it**. The
   * description is only worth having if it is a description of the right work,
   * and Claude's own title measurably is not: it is written once, at an
   * arbitrary point, about whatever the conversation had drifted to. So a
   * deliberate rename still gains a topic, and the agent's guess no longer does.
   */
  it('lets a pinned session gain a topic, with the key still in front', () => {
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().renameSession(id, 'back key interception', 'rename');

    expect(sessionAt(id).name).toBe('HIVE-73-back-key-interception');
    // The pin is not spent by being honoured once.
    expect(sessionAt(id).namePinned).toBe(true);
  });

  it('keeps the bare key against the agent’s own late title', () => {
    /*
      The reported defect that first-prompt naming fixes. A session opened for HIVE-123 came back
      called `HIVE-123-pr-157-merge-check`, because Claude titled it after a
      merge check it happened to be running three hundred turns later. The key
      alone is the name the user asked for.
    */
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().renameSession(id, 'PR 157 merge check', 'agent');

    expect(sessionAt(id).name).toBe('HIVE-73');
  });

  it('does not grow the name on every repaint', () => {
    /**
     * The failure this guards is a name a word longer each frame. Claude
     * repaints its title several times a second, so a normaliser that took the
     * *current name* as the prefix rather than the ticket would compound —
     * `HIVE-73-back-key-interception-back-key-interception` and on from there.
     */
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    for (let i = 0; i < 5; i += 1) {
      useHiveStore.getState().renameSession(id, 'back key interception', 'rename');
    }

    expect(sessionAt(id).name).toBe('HIVE-73-back-key-interception');
  });

  it('keeps the pinned key even when the title names a different ticket', () => {
    // A session routinely discusses another issue; the pin is what the user
    // said this session is *for*.
    const id = spawn();
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    useHiveStore.getState().renameSession(id, 'fixing hive-99 regression', 'rename');

    expect(sessionAt(id).name).toBe('HIVE-73-fixing-regression');
  });

  /**
   * The ticket-card spawn, which is the path the feature is *for* (HIVE-108).
   *
   * It used to send the key as `--name`, which is exactly what suppresses
   * Claude's titling — so the one kind of session most worth describing was the
   * one guaranteed never to describe itself. The key is kept by pinning it
   * instead, and the pin has to be set here: `setSessionTicket` is the
   * mid-session path and never runs for a session opened from a card.
   */
  it('pins a ticket-card spawn, so its key survives the agent’s first title', () => {
    const id = useHiveStore
      .getState()
      .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
    expect(sessionAt(id).namePinned).toBe(true);

    // Under first-prompt naming the key survives by itself: the row is already named, so
    // the agent's guess never reaches the prefix machinery at all.
    useHiveStore.getState().renameSession(id, 'back key interception', 'agent');
    expect(sessionAt(id).name).toBe('HIVE-73');

    // A person saying so still gets the topic in behind the key.
    useHiveStore.getState().renameSession(id, 'back key interception', 'rename');
    expect(sessionAt(id).name).toBe('HIVE-73-back-key-interception');
  });

  /**
   * Two sessions reaching one title (HIVE-109).
   *
   * Not hypothetical: asking two live sessions "whats the time now" put
   * `"aiTitle":"Current time"` in *both* transcripts. HIVE-108 refused the
   * second, so a row sat on `sess-0n` for the rest of its life while its own
   * transcript held a perfectly good name.
   */
  it('numbers a name a live session already holds, rather than refusing it', () => {
    const first = spawn();
    const second = spawn();
    useHiveStore.getState().renameSession(first, 'Current time');

    useHiveStore.getState().renameSession(second, 'Current time');

    expect(sessionAt(first).name).toBe('current-time');
    expect(sessionAt(second).name).toBe('current-time-2');
  });

  it('keeps numbering past the second collision', () => {
    const ids = [spawn(), spawn(), spawn()];
    for (const id of ids) useHiveStore.getState().renameSession(id, 'Current time');

    expect(ids.map((id) => sessionAt(id).name)).toEqual([
      'current-time',
      'current-time-2',
      'current-time-3',
    ]);
  });

  it('does not renumber on every repaint', () => {
    /**
     * The property HIVE-108 mis-traced when it chose refusal over a suffix:
     * "a `-2` would not survive the next repaint … a write per frame, forever".
     * It survives, because the comparison happens *after* disambiguation.
     */
    const first = spawn();
    const second = spawn();
    useHiveStore.getState().renameSession(first, 'Current time');
    useHiveStore.getState().renameSession(second, 'Current time');

    const before = useHiveStore.getState().entities;
    for (let i = 0; i < 5; i += 1) {
      useHiveStore.getState().renameSession(second, 'Current time');
    }

    // Not merely the same name — the very same object, so no re-render.
    expect(useHiveStore.getState().entities).toBe(before);
    expect(sessionAt(second).name).toBe('current-time-2');
  });

  it('keeps its number when the row holding the bare name ends', () => {
    /**
     * Otherwise a row the user is watching renames itself for a reason they did
     * nothing to cause — the moment some *other* session finished.
     */
    const first = spawn();
    const second = spawn();
    useHiveStore.getState().renameSession(first, 'Current time');
    useHiveStore.getState().renameSession(second, 'Current time');

    useHiveStore.getState().setSessionStatus(first, 'terminated');
    useHiveStore.getState().renameSession(second, 'Current time');

    expect(sessionAt(second).name).toBe('current-time-2');
  });

  it('carries the pin, the name and the branch across a /clear', () => {
    /**
     * A pinned name is a fact about the *terminal* — "this one is working
     * HIVE-73" — exactly as `ticket` is, and the successor inherits `ticket`.
     * Dropping the name would leave a row on the ticket card wearing whatever
     * the agent auto-titled its next conversation.
     */
    const id = spawn();
    useHiveStore.getState().setSessionBranch(id, 'feat/thing', '/repo/wt');
    useHiveStore.getState().setSessionTicket(id, 'HIVE-73');

    const successorId = useHiveStore.getState().clearSession(id);
    expect(successorId).not.toBeNull();

    const successor = sessionAt(successorId as string);
    expect(successor.name).toBe('HIVE-73');
    expect(successor.namePinned).toBe(true);
    expect(successor.ticket).toBe('HIVE-73');
    expect(successor.branch).toBe('feat/thing');
    expect(successor.cwd).toBe('/repo/wt');
  });

  it('gives a successor no branch when its predecessor had none observed', () => {
    // Spread rather than assigned, so the successor's shape matches a session
    // nobody has looked at rather than carrying an explicit `undefined`.
    const id = spawn();

    const successorId = useHiveStore.getState().clearSession(id);
    const successor = sessionAt(successorId as string);

    expect('branch' in successor).toBe(false);
    expect('cwd' in successor).toBe(false);
  });
});
