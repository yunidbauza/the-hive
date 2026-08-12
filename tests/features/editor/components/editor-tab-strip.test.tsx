import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorTabStrip } from '@features/editor/components/editor-tab-strip';
import { fileKey, useEditorStore } from '@stores/editor-store';

/**
 * The open-files strip.
 *
 * The interesting property is `showTerminalTab`, which is the whole interaction
 * between the two editor settings: a Terminal entry exists exactly when the
 * terminal is hidden, which is only ever full-stage placement.
 */

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
}));

const store = () => useEditorStore.getState();

async function openTwoFiles(): Promise<void> {
  await act(async () => {
    store().openFile('demo', 'src/a.ts');
    store().openFile('demo', 'src/b.ts');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue({
    ok: true,
    value: { text: 'x\n', mtimeMs: 1, size: 2 },
  });
  useEditorStore.getState().reset();
});

afterEach(() => {
  useEditorStore.getState().reset();
});

describe('EditorTabStrip', () => {
  it('renders nothing when no file is open', () => {
    const { container } = render(<EditorTabStrip showTerminalTab />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a tab per open file', async () => {
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab={false} />);

    expect(screen.getByRole('tab', { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /b\.ts/ })).toBeInTheDocument();
  });

  /**
   * The rule that unifies the four placement × nav combinations. In a split the
   * terminal is already on screen, and an entry offering to "go to" it would
   * point at something the user is looking at.
   */
  it('offers a Terminal entry only when asked', async () => {
    await openTwoFiles();
    const { rerender } = render(<EditorTabStrip showTerminalTab />);
    expect(screen.getByRole('tab', { name: /Terminal/ })).toBeInTheDocument();

    rerender(<EditorTabStrip showTerminalTab={false} />);
    expect(screen.queryByRole('tab', { name: /Terminal/ })).not.toBeInTheDocument();
  });

  it('marks the active tab, and switching changes it', async () => {
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab />);

    expect(screen.getByRole('tab', { name: /b\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await userEvent.click(screen.getByRole('tab', { name: /a\.ts/ }));

    expect(store().activeKey).toBe(fileKey('demo', 'src/a.ts'));
  });

  it('returns to the terminal without closing anything', async () => {
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab />);

    await userEvent.click(screen.getByRole('tab', { name: /Terminal/ }));

    expect(store().activeKey).toBeNull();
    expect(store().openFiles).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Terminal/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('closes a file from its own control', async () => {
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab />);

    await userEvent.click(screen.getByRole('button', { name: /Close a\.ts/ }));

    expect(store().openFiles.map((f) => f.name)).toEqual(['b.ts']);
  });

  /**
   * The dirty dot lives inside the label, not in place of the close control.
   * Swapping the × for a dot moves the control at exactly the moment you most
   * want to close the tab deliberately.
   */
  it('marks a dirty tab and keeps its close control', async () => {
    await openTwoFiles();
    await act(async () => {
      store().edit(fileKey('demo', 'src/a.ts'), 'changed');
    });

    render(<EditorTabStrip showTerminalTab />);

    expect(
      screen.getByRole('tab', { name: /a\.ts.*unsaved changes/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Close a\.ts/ }),
    ).toBeInTheDocument();
  });
});
