import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorPane } from '@features/editor/components/editor-pane';
import { MAX_FILE_BYTES } from '@shared/fs-contract';
import { useAppearanceStore } from '@stores/appearance-store';
import { fileKey, useEditorStore } from '@stores/editor-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The document half of the stage.
 *
 * Everything that decides *what* is on screen is here; everything that decides
 * *where* is in `center-stage.tsx`. This file therefore never renders a split —
 * the pane is identical in both placements, which is the property that makes
 * the two settings independent.
 */

const { readFile, writeFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
  writeFile,
}));

const store = () => useEditorStore.getState();
const KEY = fileKey('demo', 'src/app.ts');

const content = (text: string, mtimeMs = 100) => ({
  ok: true as const,
  value: { text, mtimeMs, size: text.length },
});

async function openFile(relPath = 'src/app.ts'): Promise<void> {
  await act(async () => {
    store().openFile('demo', relPath);
  });
}

const docText = (container: HTMLElement) =>
  container.querySelector('.cm-content')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(content('export {};\n'));
  writeFile.mockResolvedValue({ ok: true, mtimeMs: 200 });
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
});

afterEach(() => {
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
});

describe('EditorPane', () => {
  /**
   * The pane used to render nothing here. It now holds a creature and a line,
   * which is strictly better than a blank rectangle — but it is still a state
   * the user almost never reaches: `center-stage` unmounts this whole subtree
   * the moment `activeKey` goes null, so this is the
   * inconsistent-for-one-frame case rather than "the user closed everything".
   */
  it('holds a creature when it is mounted with no active file', () => {
    const { container } = render(<EditorPane />);

    expect(container).not.toBeEmptyDOMElement();
    expect(
      container.querySelector('[data-creature="spire"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Open a file from the explorer to edit it here.'),
    ).toBeInTheDocument();
  });

  it('renders the file’s text', async () => {
    await openFile();
    const { container } = render(<EditorPane />);

    expect(docText(container)).toContain('export {};');
  });

  /**
   * A refusal is a decline, not a failure, and it says which kind and how big.
   * "Preview not available" without a number is a shrug.
   */
  it('explains a file that is too large, with its size', async () => {
    readFile.mockResolvedValue({
      ok: true,
      value: { refused: 'too-large', size: MAX_FILE_BYTES + 1 },
    });
    await openFile('big.json');
    render(<EditorPane />);

    expect(screen.getByText(/Preview not available/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument();
  });

  it('explains a binary file', async () => {
    readFile.mockResolvedValue({
      ok: true,
      value: { refused: 'binary', size: 2048 },
    });
    await openFile('logo.png');
    render(<EditorPane />);

    expect(screen.getByText(/this file is binary/)).toBeInTheDocument();
  });

  it('says when the file no longer exists', async () => {
    readFile.mockResolvedValue({
      ok: false,
      error: { code: 'ENOENT', message: 'cannot read that path' },
    });
    await openFile('gone.ts');
    render(<EditorPane />);

    expect(screen.getByText(/no longer exists on disk/)).toBeInTheDocument();
  });

  it('surfaces a read error that is not a missing file', async () => {
    readFile.mockResolvedValue({
      ok: false,
      error: { code: 'EACCES', message: 'the filesystem refused that operation' },
    });
    await openFile();
    render(<EditorPane />);

    expect(
      screen.getByText(/the filesystem refused that operation/),
    ).toBeInTheDocument();
  });
});

describe('EditorPane — read-only and editing', () => {
  it('is editable by default', async () => {
    await openFile();
    const { container } = render(<EditorPane />);

    // The default flipped: the agent can absorb a file that moved under it, and
    // a read-only editor stopped the *user* taking part rather than preventing
    // the conflict. See `appearance-store`'s `editorEditable`.
    expect(
      container.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ).toBe('true');
  });

  it('goes read-only when the setting is off', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorEditable(false);
    });
    await openFile();
    const { container } = render(<EditorPane />);

    expect(
      container.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ).not.toBe('true');
  });

  it('becomes editable when the setting is on', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorEditable(true);
    });
    await openFile();
    const { container } = render(<EditorPane />);

    expect(
      container.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ).toBe('true');
  });
});

describe('EditorPane — the disk disagreeing', () => {
  /**
   * Stale and conflict arrive from opposite directions and offer opposite
   * defaults. Stale is "the disk moved, you have not saved yet". Conflict is
   * "you tried to save and were refused", where the user has already expressed
   * an intent to write.
   */
  it('offers only Reload when a dirty buffer went stale', async () => {
    await openFile();
    await act(async () => {
      store().edit(KEY, 'mine\n');
      store().reconcile('demo', ['src/app.ts'], '');
    });

    render(<EditorPane />);

    expect(screen.getByText(/Changed on disk\. Your unsaved edits/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument();
  });

  it('offers Reload and Overwrite after a refused save', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorEditable(true);
    });
    await openFile();
    writeFile.mockResolvedValue({ ok: false, conflict: true, mtimeMs: 500 });

    await act(async () => {
      store().edit(KEY, 'mine\n');
      await store().save(KEY);
    });

    render(<EditorPane />);

    expect(screen.getByText(/nothing was written/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument();
  });

  it('reloads from the banner', async () => {
    await openFile();
    await act(async () => {
      store().edit(KEY, 'mine\n');
      store().reconcile('demo', ['src/app.ts'], '');
    });

    readFile.mockResolvedValue(content('theirs\n', 900));
    render(<EditorPane />);
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await vi.waitFor(() => {
      expect(store().openFiles[0]).toMatchObject({
        text: 'theirs\n',
        dirty: false,
        staleOnDisk: false,
      });
    });
  });

  it('overwrites from the banner', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorEditable(true);
    });
    await openFile();
    writeFile.mockResolvedValue({ ok: false, conflict: true, mtimeMs: 500 });
    await act(async () => {
      store().edit(KEY, 'mine\n');
      await store().save(KEY);
    });

    readFile.mockResolvedValue(content('theirs\n', 500));
    writeFile.mockResolvedValue({ ok: true, mtimeMs: 600 });

    render(<EditorPane />);
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenLastCalledWith(
        'demo',
        'src/app.ts',
        'mine\n',
        500,
        undefined,
      );
    });
  });
});

describe('EditorPane — single-file mode', () => {
  beforeEach(() => {
    act(() => {
      useAppearanceStore.getState().setEditorNav('single');
    });
  });

  /**
   * With no tab strip there is no × and no Terminal entry, so the pane grows
   * its own header — and Escape becomes the only keyboard way out, which is
   * what earns it a window listener.
   */
  it('shows the path and a close control instead of a tab strip', async () => {
    await openFile();
    render(<EditorPane />);

    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close app\.ts/ })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    await openFile();
    render(<EditorPane />);

    await userEvent.keyboard('{Escape}');

    expect(store().openFiles).toHaveLength(0);
  });

  it('closes from its own control', async () => {
    await openFile();
    render(<EditorPane />);

    await userEvent.click(screen.getByRole('button', { name: /Close app\.ts/ }));

    expect(store().openFiles).toHaveLength(0);
  });

  /**
   * Escape reaches this listener while an overlay is up, because the pane stays
   * mounted inside the merely-`hidden` stage. Radix dismisses the dialog on the
   * same key — so without this guard one press closed the dialog *and* the file,
   * discarding unsaved edits.
   */
  it('leaves Escape to an open overlay', async () => {
    await openFile();
    act(() => {
      useUiStore.getState().openSettings();
    });
    render(<EditorPane />);

    await userEvent.keyboard('{Escape}');

    expect(store().openFiles).toHaveLength(1);
  });

  it('leaves Escape to the picker', async () => {
    await openFile();
    act(() => {
      useUiStore.getState().openPicker();
    });
    render(<EditorPane />);

    await userEvent.keyboard('{Escape}');

    expect(store().openFiles).toHaveLength(1);
  });

  /**
   * Escape in the message row or the console is a gesture about that input, not
   * a request to close a file the user may not even be looking at in `split`.
   */
  it('leaves Escape to a focused text field', async () => {
    await openFile();
    render(
      <>
        <input aria-label="message" />
        <EditorPane />
      </>,
    );

    screen.getByLabelText('message').focus();
    await userEvent.keyboard('{Escape}');

    expect(store().openFiles).toHaveLength(1);
  });

  it('does not close on Escape in tab mode', async () => {
    act(() => {
      useAppearanceStore.getState().setEditorNav('tabs');
    });
    await openFile();
    render(<EditorPane />);

    await userEvent.keyboard('{Escape}');

    expect(store().openFiles).toHaveLength(1);
  });

  it('marks a dirty buffer in its header', async () => {
    await openFile();
    await act(async () => {
      store().edit(KEY, 'mine\n');
    });
    render(<EditorPane />);

    expect(screen.getByText('unsaved changes')).toBeInTheDocument();
  });
});
