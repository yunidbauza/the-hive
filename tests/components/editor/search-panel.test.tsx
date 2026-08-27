import {
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
} from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSearchPanel } from '@components/editor/search-panel';

/**
 * ⌘F's panel.
 *
 * Driven through a **real `EditorView`** for the same reason
 * `editor-surface.test.tsx` is: CodeMirror renders without measuring, so the
 * panel is genuinely in the DOM here. What is asserted is the seam between the
 * two — that the panel reads its state from CodeMirror's search query and
 * writes back through it — never colour, which is Playwright's job.
 */

let view: EditorView;
let host: HTMLDivElement;

const DOC = ['const alpha = 1;', 'const Alpha = 2;', 'const beta = alpha;'].join(
  '\n',
);

const open = async (): Promise<void> => {
  await act(async () => {
    openSearchPanel(view);
  });
};

const findField = (): HTMLInputElement =>
  screen.getByLabelText('Find') as HTMLInputElement;

const type = async (value: string): Promise<void> => {
  await act(async () => {
    fireEvent.change(findField(), { target: { value } });
  });
};

const press = async (
  element: Element,
  key: string,
  init: Record<string, unknown> = {},
): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(element, { key, ...init });
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: DOC,
      extensions: [search({ createPanel: createSearchPanel })],
    }),
  });
});

afterEach(() => {
  view.destroy();
  host.remove();
});

describe('the panel', () => {
  it('opens with a find field and no replace row', async () => {
    await open();

    expect(findField()).toBeInTheDocument();
    expect(screen.queryByLabelText('Replace')).not.toBeInTheDocument();
  });

  /** CodeMirror focuses whatever carries this when the panel opens. */
  it('tags the find field so CodeMirror knows where focus goes', async () => {
    await open();

    expect(findField().getAttribute('main-field')).toBe('true');
  });

  it('reveals and hides the replace row from the chevron', async () => {
    await open();

    await act(async () => {
      screen.getByRole('button', { name: 'Show replace' }).click();
    });
    expect(screen.getByLabelText('Replace')).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: 'Hide replace' }).click();
    });
    expect(screen.queryByLabelText('Replace')).not.toBeInTheDocument();
  });
});

describe('the query', () => {
  it('writes what is typed back into CodeMirror, not into its own state', async () => {
    await open();
    await type('alpha');

    expect(getSearchQuery(view.state).search).toBe('alpha');
  });

  it('flips a toggle on the query rather than locally', async () => {
    await open();
    await type('alpha');

    await act(async () => {
      screen.getByRole('button', { name: 'Match case' }).click();
    });

    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
  });

  it("reports a toggle's state to assistive tech", async () => {
    await open();

    const toggle = screen.getByRole('button', { name: 'Use regular expression' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await act(async () => {
      toggle.click();
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the match counter', () => {
  it('counts every match, case-insensitively by default', async () => {
    await open();
    await type('alpha');

    // `alpha`, `Alpha`, and the `alpha` in the third line.
    await waitFor(() => expect(screen.getByText(/of 3$/)).toBeInTheDocument());
  });

  it('narrows when match-case is on', async () => {
    await open();
    await type('alpha');
    await act(async () => {
      screen.getByRole('button', { name: 'Match case' }).click();
    });

    await waitFor(() => expect(screen.getByText(/of 2$/)).toBeInTheDocument());
  });

  it('says so when nothing matches, and stays quiet when nothing is typed', async () => {
    await open();
    expect(screen.queryByText('No results')).not.toBeInTheDocument();

    await type('nothing-here');
    await waitFor(() =>
      expect(screen.getByText('No results')).toBeInTheDocument(),
    );
  });
});

describe('the keyboard', () => {
  /**
   * The reason both fields are real inputs: `editor-pane.tsx` installs a
   * window-level Escape listener that closes the open file, and it bails for
   * `HTMLInputElement`. A styled contenteditable would close the document.
   */
  it('closes on Escape from the find field', async () => {
    await open();
    expect(searchPanelOpen(view.state)).toBe(true);

    await press(findField(), 'Escape');

    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('moves the selection to a match on Enter', async () => {
    await open();
    await type('beta');

    await press(findField(), 'Enter');

    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe('beta');
  });

  it('walks backwards on Shift+Enter', async () => {
    await open();
    await type('alpha');

    await press(findField(), 'Enter');
    const forward = view.state.selection.main.from;

    await press(findField(), 'Enter', { shiftKey: true });
    expect(view.state.selection.main.from).not.toBe(forward);
  });
});

describe('lifecycle', () => {
  /**
   * The React root is unmounted in a microtask, because `destroy()` can be
   * called from inside CodeMirror's own update cycle. If that ever regressed,
   * the panel's DOM would outlive the panel.
   */
  it('tears the panel down when it closes', async () => {
    await open();
    expect(findField()).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: 'Close' }).click();
    });

    await waitFor(() =>
      expect(screen.queryByLabelText('Find')).not.toBeInTheDocument(),
    );
  });
});
