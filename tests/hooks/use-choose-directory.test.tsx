import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChooseDirectory } from '@hooks/use-choose-directory';
import {
  resetProjectConfig,
  setAttachedServerForTest,
  setProjectConfigForTest,
} from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';

const chooseProjectDirectory = vi.fn();

vi.mock('@lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/project-config')>();
  return { ...actual, chooseProjectDirectory: () => chooseProjectDirectory() };
});

/**
 * Put this window in the attached state, or out of it.
 *
 * The snapshot stays the plain one in both cases: while attached, `config:get`
 * is answered by the server, whose own `remote.mode` reads `'local'`.
 * Attachment is the runtime fact beside it (HIVE-144 review, C1).
 */
function attachedTo(server: string | null): void {
  setProjectConfigForTest(emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'));
  setAttachedServerForTest(server);
}

beforeEach(() => {
  chooseProjectDirectory.mockReset();
  chooseProjectDirectory.mockResolvedValue(null);
});

afterEach(() => {
  resetProjectConfig();
});

/**
 * The shared answer to "ask the user for a directory" (HIVE-146).
 *
 * Three surfaces use it — mapping a project, repointing one, choosing where a
 * clone lands — and `use-add-project.test.tsx` covers one of them end to end.
 * What lives here is the hook's own contract, which no caller's test is
 * responsible for: which chooser opens, the re-entrancy guard, and the context
 * that has to survive a round trip without being read back off component state.
 */
describe('useChooseDirectory', () => {
  describe('local', () => {
    beforeEach(() => attachedTo(null));

    it('opens the native dialog and delivers what it returned', async () => {
      chooseProjectDirectory.mockResolvedValue('/tmp/picked');
      const onChosen = vi.fn();

      const { result } = renderHook(() => useChooseDirectory<void>(onChosen));
      await act(async () => result.current.choose());

      expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
      expect(onChosen).toHaveBeenCalledWith('/tmp/picked', undefined);
      expect(result.current.picking).toBe(false);
    });

    it('delivers nothing when the dialog is cancelled', async () => {
      chooseProjectDirectory.mockResolvedValue(null);
      const onChosen = vi.fn();

      const { result } = renderHook(() => useChooseDirectory<void>(onChosen));
      await act(async () => result.current.choose());

      expect(onChosen).not.toHaveBeenCalled();
    });

    /**
     * The reason `choosing` exists. The dialog is modal to the window, so there
     * is nothing to spin over — the flag stops a second `invoke` racing the
     * first, which would open two dialogs and write twice.
     */
    it('opens no second dialog while the first is still open', async () => {
      let settle: (path: string | null) => void = () => {};
      chooseProjectDirectory.mockReturnValue(
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
      );

      const { result } = renderHook(() => useChooseDirectory<void>(vi.fn()));
      act(() => result.current.choose());
      await waitFor(() => expect(result.current.choosing).toBe(true));

      act(() => result.current.choose());
      expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);

      await act(async () => settle(null));
      expect(result.current.choosing).toBe(false);
    });

    it('releases the control when the dialog itself fails', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      chooseProjectDirectory.mockRejectedValue(new Error('no bridge'));

      const { result } = renderHook(() => useChooseDirectory<void>(vi.fn()));
      await act(async () => result.current.choose());

      expect(result.current.choosing).toBe(false);
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });

    it('swallows a rejected write rather than leaving the click unhandled', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      chooseProjectDirectory.mockResolvedValue('/tmp/picked');

      const { result } = renderHook(() =>
        useChooseDirectory<void>(() => Promise.reject(new Error('write failed'))),
      );
      await act(async () => result.current.choose());

      expect(result.current.choosing).toBe(false);
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });

  describe('attached', () => {
    beforeEach(() => attachedTo('mini.tail1234.ts.net'));

    it('opens the picker and never the dialog', async () => {
      const { result } = renderHook(() => useChooseDirectory<void>(vi.fn()));
      await act(async () => result.current.choose());

      expect(result.current.picking).toBe(true);
      expect(chooseProjectDirectory).not.toHaveBeenCalled();
    });

    it('delivers the picked path and closes', async () => {
      const onChosen = vi.fn();
      const { result } = renderHook(() => useChooseDirectory<void>(onChosen));
      await act(async () => result.current.choose());

      await act(async () => result.current.onPicked('/srv/app'));

      expect(onChosen).toHaveBeenCalledWith('/srv/app', undefined);
      expect(result.current.picking).toBe(false);
    });

    it('delivers nothing when the picker is dismissed', async () => {
      const onChosen = vi.fn();
      const { result } = renderHook(() => useChooseDirectory<void>(onChosen));
      await act(async () => result.current.choose());
      await act(async () => result.current.cancelPicking());

      expect(result.current.picking).toBe(false);
      expect(onChosen).not.toHaveBeenCalled();
    });
  });

  /**
   * The context is the whole reason `choose` takes an argument.
   *
   * The projects list mounts one picker for every row, so a chosen path has to
   * carry which project it was for. Reading that off component state is unsound
   * — the click that sets it also calls `choose`, so `choose` runs before the
   * render that carries it — and these are the assertions that would fail if it
   * were ever done that way again.
   */
  describe('the context it carries', () => {
    it('hands back what the click passed in, through the picker', async () => {
      attachedTo('mini.tail1234.ts.net');
      const onChosen = vi.fn();

      const { result } = renderHook(() =>
        useChooseDirectory<string>(onChosen),
      );
      await act(async () => result.current.choose('the-hive'));
      await act(async () => result.current.onPicked('/srv/the-hive'));

      expect(onChosen).toHaveBeenCalledWith('/srv/the-hive', 'the-hive');
    });

    it('hands back what the click passed in, through the dialog', async () => {
      attachedTo(null);
      chooseProjectDirectory.mockResolvedValue('/repos/moved');
      const onChosen = vi.fn();

      const { result } = renderHook(() =>
        useChooseDirectory<string>(onChosen),
      );
      await act(async () => result.current.choose('nova-web'));

      expect(onChosen).toHaveBeenCalledWith('/repos/moved', 'nova-web');
    });

    /**
     * A second choice must not inherit the first's subject. This is the shape
     * the bug would take in the projects list: open the menu on one row, cancel,
     * open it on another, and repoint the row you had already dismissed.
     */
    it('does not let a dismissed choice leak into the next one', async () => {
      attachedTo('mini.tail1234.ts.net');
      const onChosen = vi.fn();

      const { result } = renderHook(() =>
        useChooseDirectory<string>(onChosen),
      );
      await act(async () => result.current.choose('first'));
      await act(async () => result.current.cancelPicking());
      await act(async () => result.current.choose('second'));
      await act(async () => result.current.onPicked('/srv/x'));

      expect(onChosen).toHaveBeenCalledTimes(1);
      expect(onChosen).toHaveBeenCalledWith('/srv/x', 'second');
    });

    /**
     * A path arriving with nothing in flight delivers nothing. Not reachable
     * from the UI — the picker only exists while `picking` is true — but it is
     * what stops a stray `onPicked` writing against a `null` subject.
     */
    it('delivers nothing when no choice is in flight', async () => {
      attachedTo('mini.tail1234.ts.net');
      const onChosen = vi.fn();

      const { result } = renderHook(() =>
        useChooseDirectory<string>(onChosen),
      );
      await act(async () => result.current.onPicked('/srv/x'));

      expect(onChosen).not.toHaveBeenCalled();
    });
  });
});
