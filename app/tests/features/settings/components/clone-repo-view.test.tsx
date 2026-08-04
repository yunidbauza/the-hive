import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot, type CloneDoneEvent } from '@shared/config-contract';

import { CloneRepoView } from '@features/settings/components/clone-repo-view';
import { resetPtyChannels } from '@lib/terminal/pty-transport';

const chooseProjectDirectory = vi.fn();
const startClone = vi.fn();
const cancelClone = vi.fn();

/** The subscriber the view registered, so a test can conclude a clone. */
let emitDone: ((event: CloneDoneEvent) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return { ...actual, chooseProjectDirectory: () => chooseProjectDirectory() };
});

vi.mock('@/lib/clone-repo', () => ({
  startClone: (request: unknown) => startClone(request),
  cancelClone: () => cancelClone(),
  onCloneDone: (callback: (event: CloneDoneEvent) => void) => {
    emitDone = callback;
    return unsubscribe;
  },
}));

const URL = 'https://github.com/behiques/the-hive.git';
const PARENT = '/Users/me/Projects';
const TARGET = `${PARENT}/the-hive`;

/** Fill both fields, which is what enables Clone. */
async function compose(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/repository url/i), URL);
  await user.click(screen.getByRole('button', { name: /choose/i }));
}

/**
 * The clone terminal streams over the PTY channels, so mounting it needs the
 * desktop bridge — which is not a test concession: `startClone` refuses without
 * one, so the terminal can never mount in a build that lacks it.
 */
function installBridge(): void {
  (window as { hive?: unknown }).hive = {
    pty: {
      spawn: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => Promise.resolve()),
      ack: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      onLost: () => () => {},
    },
  };
}

beforeEach(() => {
  installBridge();
  emitDone = null;
  chooseProjectDirectory.mockResolvedValue(PARENT);
  startClone.mockResolvedValue({ ok: true, targetPath: TARGET });
  cancelClone.mockResolvedValue(undefined);
});

afterEach(() => {
  /**
   * The bridge is left installed on purpose. `TerminalSurface`'s subscription
   * is a passive effect, which can flush after the test body returns — deleting
   * `window.hive` here races it and throws from inside React's commit phase.
   * `beforeEach` reinstalls a fresh stub, so nothing leaks between tests.
   */
  resetPtyChannels();
  vi.clearAllMocks();
});

describe('CloneRepoView', () => {
  it('disables Clone until both a URL and a folder are present', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();

    await user.type(screen.getByLabelText(/repository url/i), URL);
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /choose/i }));
    expect(screen.getByRole('button', { name: 'Clone' })).toBeEnabled();
  });

  it('names the folder it will create before creating it', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);

    expect(screen.getByText(TARGET)).toBeInTheDocument();
  });

  it('changes nothing when the folder dialog is cancelled', async () => {
    chooseProjectDirectory.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await user.type(screen.getByLabelText(/repository url/i), URL);
    await user.click(screen.getByRole('button', { name: /choose/i }));

    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();
  });

  it('sends the trimmed URL and the chosen parent, never a destination', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    expect(startClone).toHaveBeenCalledWith({
      url: URL,
      parentPath: PARENT,
      cols: 80,
      rows: 24,
    });
  });

  /**
   * A refusal is something to fix in the field above, not a failed clone — so
   * the pane stays composable with everything the user typed still there.
   */
  it('surfaces a refusal and stays on the form', async () => {
    startClone.mockResolvedValue({
      ok: false,
      reason: `${TARGET} already exists — choose another folder`,
    });
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeInTheDocument();
  });

  it('shows the terminal once the clone is running', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    expect(
      await screen.findByRole('button', { name: /cancel clone/i }),
    ).toBeInTheDocument();
    // The form is gone; the pane belongs to the terminal now.
    expect(screen.queryByLabelText(/repository url/i)).not.toBeInTheDocument();
  });

  it('asks main to cancel a running clone', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));
    await user.click(
      await screen.findByRole('button', { name: /cancel clone/i }),
    );

    expect(cancelClone).toHaveBeenCalledOnce();
  });

  it('leaves for the project list when the clone succeeds', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<CloneRepoView onDone={onDone} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    act(() =>
      emitDone?.({
        ok: true,
        targetPath: TARGET,
        reason: null,
        snapshot: emptySnapshot('/tmp/config.json'),
      }),
    );

    expect(onDone).toHaveBeenCalled();
  });

  it('offers Retry and Back when the clone fails', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    act(() =>
      emitDone?.({
        ok: false,
        targetPath: null,
        reason: 'git exited with code 128',
        snapshot: emptySnapshot('/tmp/config.json'),
      }),
    );

    expect(await screen.findByText(/git exited with code 128/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument();
  });

  it('Retry returns to the form with the fields intact', async () => {
    const user = userEvent.setup();
    render(<CloneRepoView onDone={() => {}} />);

    await compose(user);
    await user.click(screen.getByRole('button', { name: 'Clone' }));
    act(() =>
      emitDone?.({
        ok: false,
        targetPath: null,
        reason: 'git exited with code 128',
        snapshot: emptySnapshot('/tmp/config.json'),
      }),
    );

    await user.click(await screen.findByRole('button', { name: /retry/i }));

    expect(screen.getByLabelText(/repository url/i)).toHaveValue(URL);
    expect(screen.getByText(TARGET)).toBeInTheDocument();
  });

  it('goes back to the project list', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<CloneRepoView onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: /projects/i }));

    expect(onDone).toHaveBeenCalled();
  });

  it('unsubscribes from the outcome on unmount', () => {
    const { unmount } = render(<CloneRepoView onDone={() => {}} />);

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
