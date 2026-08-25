import { beforeEach, describe, expect, it } from 'vitest';

import { isSession } from '@/types/entity';

import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { useHiveStore } from '@stores/hive-store';

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

  it('de-duplicates against a session already named for the ticket', () => {
    const first = useHiveStore
      .getState()
      .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
    const second = spawn();

    useHiveStore.getState().setSessionTicket(second, 'HIVE-73');

    expect(sessionAt(first).name).toBe('HIVE-73');
    expect(sessionAt(second).name).toBe('HIVE-73-2');
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
    // HIVE-61's behaviour, unchanged for every session the app has not named.
    const id = spawn();

    useHiveStore.getState().renameSession(id, 'fix the login bug');

    expect(sessionAt(id).name).toBe('fix the login bug');
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
