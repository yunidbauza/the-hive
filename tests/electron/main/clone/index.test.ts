// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLONE_ENTITY_ID,
  emptySnapshot,
  type ConfigSnapshot,
} from '../../../../electron/shared/config-contract';

import {
  createCloneFlow,
  type CloneFlowOptions,
} from '../../../../electron/main/clone';

/**
 * The clone flow (story 102).
 *
 * Main owns every decision here — what to run, whether it succeeded, what to
 * write, what to delete — so the whole flow is testable against fakes with no
 * filesystem and no processes. The two assertions that matter most are the
 * exact argv (argument injection) and that a failure removes the directory
 * (the epic's "failure leaves no half-clone").
 */

const SNAPSHOT: ConfigSnapshot = emptySnapshot('/Users/me/.hive/config.json');

const REQUEST = {
  url: 'https://github.com/behiques/the-hive.git',
  parentPath: '/Users/me/Projects',
  cols: 80,
  rows: 24,
};

const TARGET = '/Users/me/Projects/the-hive';

function makeFlow(overrides: Partial<CloneFlowOptions> = {}) {
  const openCommand = vi.fn();
  const kill = vi.fn();
  const emit = vi.fn();
  const rmSync = vi.fn();
  const addProject = vi.fn().mockReturnValue(SNAPSHOT);

  const flow = createCloneFlow({
    sessions: { openCommand, kill },
    // The parent exists; the target does not.
    fs: { existsSync: (path: string) => path === '/Users/me/Projects', rmSync },
    resolveParent: (path: string) =>
      path === '/Users/me/Projects'
        ? { ok: true, path }
        : { ok: false, reason: `cannot clone into ${path} (missing)` },
    addProject,
    getConfig: () => SNAPSHOT,
    emit,
    ...overrides,
  });

  return { flow, openCommand, kill, emit, rmSync, addProject };
}

/** The `onExit` the flow handed to `openCommand`. */
const exitOf = (openCommand: ReturnType<typeof vi.fn>) =>
  openCommand.mock.calls[0]![0].onExit as (result: {
    exitCode: number;
    signal: number;
    lost: boolean;
    message?: string;
  }) => void;

describe('createCloneFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns git with an argv array and a -- terminator', () => {
    const { flow, openCommand } = makeFlow();

    expect(flow.start(REQUEST)).toEqual({ ok: true, targetPath: TARGET });
    expect(openCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: CLONE_ENTITY_ID,
        cwd: '/Users/me/Projects',
        file: 'git',
        args: [
          'clone',
          '--progress',
          '--',
          'https://github.com/behiques/the-hive.git',
          'the-hive',
        ],
        cols: 80,
        rows: 24,
      }),
    );
  });

  it('refuses a URL that git would read as a flag, before spawning anything', () => {
    const { flow, openCommand } = makeFlow();

    expect(flow.start({ ...REQUEST, url: '--upload-pack=x' })).toMatchObject({
      ok: false,
    });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses when the parent path does not resolve', () => {
    const { flow, openCommand } = makeFlow();

    expect(
      flow.start({ ...REQUEST, parentPath: '/nowhere' }),
    ).toMatchObject({ ok: false });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses when the target already exists', () => {
    const { flow, openCommand } = makeFlow({
      fs: { existsSync: () => true, rmSync: vi.fn() },
    });

    expect(flow.start(REQUEST)).toEqual({
      ok: false,
      reason: `${TARGET} already exists — choose another folder`,
    });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses a second clone while one is running', () => {
    const { flow } = makeFlow();

    flow.start(REQUEST);
    expect(flow.start(REQUEST)).toMatchObject({ ok: false });
  });

  it('adds the project with origin cloned on exit 0', () => {
    const { flow, openCommand, addProject, emit } = makeFlow();
    flow.start(REQUEST);

    exitOf(openCommand)({ exitCode: 0, signal: 0, lost: false });

    expect(addProject).toHaveBeenCalledWith({ path: TARGET }, 'cloned');
    expect(emit).toHaveBeenCalledWith({
      ok: true,
      targetPath: TARGET,
      reason: null,
      snapshot: SNAPSHOT,
    });
  });

  it('removes the directory and writes nothing on a non-zero exit', () => {
    const { flow, openCommand, addProject, rmSync, emit } = makeFlow();
    flow.start(REQUEST);

    exitOf(openCommand)({ exitCode: 128, signal: 0, lost: false });

    expect(addProject).not.toHaveBeenCalled();
    expect(rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, targetPath: null }),
    );
  });

  it('surfaces a host failure message verbatim when git could not start', () => {
    const { flow, openCommand, emit, rmSync } = makeFlow();
    flow.start(REQUEST);

    exitOf(openCommand)({
      exitCode: -1,
      signal: 0,
      lost: false,
      message: 'could not start git in /Users/me/Projects: ENOENT',
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: 'could not start git in /Users/me/Projects: ENOENT',
      }),
    );
    expect(rmSync).toHaveBeenCalled();
  });

  /**
   * The bug an end-to-end cancel caught: `git clone` killed with SIGTERM exits
   * **0 with signal 15**. A success check that read only the code registered a
   * cancelled clone as a finished project — and, once `git` had removed its own
   * partial checkout, registered a directory that was no longer there.
   */
  it('treats exit 0 with a signal as a failure, not a success', () => {
    const { flow, openCommand, addProject, rmSync, emit } = makeFlow();
    flow.start(REQUEST);

    exitOf(openCommand)({ exitCode: 0, signal: 15, lost: false });

    expect(addProject).not.toHaveBeenCalled();
    expect(rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: 'the clone was stopped before it finished',
      }),
    );
  });

  it('treats a lost host as a failure', () => {
    const { flow, openCommand, rmSync } = makeFlow();
    flow.start(REQUEST);

    exitOf(openCommand)({ exitCode: -1, signal: 0, lost: true });

    expect(rmSync).toHaveBeenCalled();
  });

  it('cancel kills the session, and cleanup waits for the exit', () => {
    const { flow, openCommand, kill, rmSync } = makeFlow();
    flow.start(REQUEST);

    flow.cancel();
    expect(kill).toHaveBeenCalledWith(CLONE_ENTITY_ID);
    /**
     * Not yet: the process still holds the directory, and removing it under a
     * live `git` produces a partially-deleted tree instead of no tree.
     */
    expect(rmSync).not.toHaveBeenCalled();

    exitOf(openCommand)({ exitCode: 143, signal: 15, lost: false });
    expect(rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
  });

  it('cancel with no clone running does nothing', () => {
    const { flow, kill } = makeFlow();

    flow.cancel();
    expect(kill).not.toHaveBeenCalled();
  });

  it('allows a new clone once the previous one finished', () => {
    const { flow, openCommand } = makeFlow();
    flow.start(REQUEST);
    exitOf(openCommand)({ exitCode: 0, signal: 0, lost: false });

    expect(flow.start(REQUEST)).toMatchObject({ ok: true });
  });

  it('dispose kills and cleans up a clone in flight', () => {
    const { flow, kill, rmSync } = makeFlow();
    flow.start(REQUEST);

    flow.dispose();

    expect(kill).toHaveBeenCalledWith(CLONE_ENTITY_ID);
    // Synchronous here, unlike cancel: the app is going away and no onExit
    // will ever run.
    expect(rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
  });

  it('dispose with no clone running does nothing', () => {
    const { flow, kill, rmSync } = makeFlow();

    flow.dispose();

    expect(kill).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('refuses and stays startable when openCommand throws', () => {
    const { flow, openCommand } = makeFlow();
    openCommand.mockImplementationOnce(() => {
      throw new Error('session limit reached (24)');
    });

    expect(flow.start(REQUEST)).toEqual({
      ok: false,
      reason: 'session limit reached (24)',
    });
    // The refusal released the slot, so the user can close a session and retry.
    expect(flow.start(REQUEST)).toMatchObject({ ok: true });
  });
});
