import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_DISABLED_REASON } from '@config/runtime';
import { useAddProject } from '@hooks/use-add-project';
import {
  resetProjectConfig,
  setAttachedServerForTest,
  setProjectConfigForTest,
} from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';

const chooseProjectDirectory = vi.fn();
const addProjectToConfig = vi.fn();

vi.mock('@lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/project-config')>();
  return {
    ...actual,
    chooseProjectDirectory: () => chooseProjectDirectory(),
    addProjectToConfig: (request: unknown) => addProjectToConfig(request),
  };
});

/**
 * Put this window in the attached state, or out of it (HIVE-144 review, C1).
 *
 * The snapshot stays the plain one in **both** cases, deliberately. An
 * attached client's `config:get` is answered by the server, so the snapshot it
 * holds is the server's — and a server is attached to nobody, so its
 * `remote.mode` reads `'local'`. Attachment is a runtime fact, and
 * `setAttachedServerForTest` is the only place it lives.
 */
function attachedTo(server: string | null): void {
  setProjectConfigForTest(emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'));
  setAttachedServerForTest(server);
}

/**
 * Mapping a directory, from wherever the app offers it (Settings, the rail).
 *
 * Both surfaces owe the user the same three guarantees — one dialog per click,
 * a write of exactly the path it returned, and nothing at all when the dialog
 * is closed. They live here rather than being asserted twice against two
 * buttons that merely happen to agree today.
 */
describe('useAddProject', () => {
  beforeEach(() => {
    chooseProjectDirectory.mockReset();
    addProjectToConfig.mockReset();
    chooseProjectDirectory.mockResolvedValue(null);
    addProjectToConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetProjectConfig();
  });

  it('writes the path the dialog returned, and no other', async () => {
    chooseProjectDirectory.mockResolvedValue('/tmp/picked');

    const { result } = renderHook(() => useAddProject());
    await act(async () => {
      result.current.addProject();
    });

    expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
    expect(addProjectToConfig).toHaveBeenCalledWith({ path: '/tmp/picked' });
  });

  it('writes nothing when the dialog is cancelled', async () => {
    chooseProjectDirectory.mockResolvedValue(null);

    const { result } = renderHook(() => useAddProject());
    await act(async () => {
      result.current.addProject();
    });

    expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
    // No write, and no error: the user closed a dialog they opened.
    expect(addProjectToConfig).not.toHaveBeenCalled();
  });

  /**
   * The reason `choosing` exists at all. The native dialog is modal to the
   * window, so there is nothing to spin *over* — the flag is here to stop a
   * second invoke racing the first, which would open two dialogs and write
   * twice.
   */
  it('opens no second dialog while the first is still open', async () => {
    let settle: (path: string | null) => void = () => {};
    chooseProjectDirectory.mockReturnValue(
      new Promise<string | null>((resolve) => {
        settle = resolve;
      }),
    );

    const { result } = renderHook(() => useAddProject());
    act(() => {
      result.current.addProject();
    });

    await waitFor(() => expect(result.current.choosing).toBe(true));

    act(() => {
      result.current.addProject();
    });
    expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(null);
    });

    expect(result.current.choosing).toBe(false);
  });

  /**
   * A broken IPC hop releases the button.
   *
   * `chooseProjectDirectory` invokes main directly rather than through the
   * config module's `mutate`, so it is the one call in this flow that can
   * reject. Without the catch the rejection escapes a fire-and-forget click
   * *and* leaves `choosing` true, which disables the only control that could
   * try again.
   */
  it('recovers when the dialog itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    chooseProjectDirectory.mockRejectedValue(new Error('no bridge'));

    const { result } = renderHook(() => useAddProject());
    await act(async () => {
      result.current.addProject();
    });

    expect(result.current.choosing).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

/**
 * While attached to someone else's Hive (HIVE-144).
 *
 * `config:choose-directory` opens a dialog on the server, which has no
 * window — `WINDOW_BOUND` (`electron/shared/remote-contract.ts`) refuses it
 * by name. `disabledReason` is what both buttons (`projects-section.tsx`,
 * `new-project-link.tsx`) render as the control's `title`; `addProject`
 * itself must never reach the bridge, since a disabled control that still
 * fired its handler would be exactly the "button that fails silently" this
 * task exists to prevent.
 */
describe('useAddProject — attached to a remote server', () => {
  beforeEach(() => {
    chooseProjectDirectory.mockReset();
    addProjectToConfig.mockReset();
  });

  afterEach(() => {
    resetProjectConfig();
  });

  it('reports no reason in local mode', () => {
    attachedTo(null);

    const { result } = renderHook(() => useAddProject());

    expect(result.current.disabledReason).toBeNull();
  });

  it("carries WINDOW_BOUND's own reason once attached", () => {
    attachedTo('mini.tail1234.ts.net');

    const { result } = renderHook(() => useAddProject());

    expect(result.current.disabledReason).toBe(REMOTE_DISABLED_REASON.chooseDirectory);
  });

  it('never opens the dialog while attached', async () => {
    attachedTo('mini.tail1234.ts.net');

    const { result } = renderHook(() => useAddProject());
    await act(async () => {
      result.current.addProject();
    });

    expect(chooseProjectDirectory).not.toHaveBeenCalled();
    expect(addProjectToConfig).not.toHaveBeenCalled();
  });
});
