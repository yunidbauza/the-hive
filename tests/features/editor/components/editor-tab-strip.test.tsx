import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EDITOR_FILE_PANEL,
  EDITOR_TERMINAL_PANEL,
  EditorTabStrip,
  editorTabId,
} from '@features/editor/components/editor-tab-strip';
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

    await userEvent.click(screen.getByTitle('Close a.ts'));

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
    expect(screen.getByTitle('Close a.ts')).toBeInTheDocument();
  });

  it('is a WAI-ARIA tablist: only tabs inside, roving tabIndex, arrows wrap, panels named (HIVE-225)', async () => {
    const user = userEvent.setup();
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab />);
    const list = screen.getByRole('tablist', { name: 'Open files' });
    expect(within(list).queryAllByRole('button')).toEqual([]);

    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(tabs[0]).toHaveAttribute('id', editorTabId(null));
    expect(tabs[0]).toHaveAttribute('aria-controls', EDITOR_TERMINAL_PANEL);
    expect(tabs[2]).toHaveAttribute('aria-controls', EDITOR_FILE_PANEL);

    tabs[2]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(store().activeKey).toBeNull();
    expect(screen.getByRole('tab', { name: /Terminal/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(store().activeKey).toBe(fileKey('demo', 'src/b.ts'));
  });

  it('closes the focused file tab on Delete and focuses the tab that takes its place (HIVE-225)', async () => {
    const user = userEvent.setup();
    await openTwoFiles();
    render(<EditorTabStrip showTerminalTab />);
    screen.getByRole('tab', { name: /b\.ts/ }).focus();
    await user.keyboard('{Delete}');
    expect(screen.queryByRole('tab', { name: /b\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveFocus();
  });

  it('puts the markdown view toggle beside the tabs, outside the tab list', async () => {
    await act(async () => {
      store().openFile('demo', 'README.md');
    });
    render(<EditorTabStrip showTerminalTab />);
    const toggle = screen.getByRole('radiogroup', { name: 'Markdown view' });
    expect(screen.getByRole('tablist')).not.toContainElement(toggle);
  });
});
