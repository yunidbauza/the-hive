import { EditorView } from '@codemirror/view';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditorSurface } from '@components/editor/editor-surface';

/**
 * The CodeMirror surface.
 *
 * **A real `EditorView`, not a mock** — and that is a genuine difference from
 * the terminal, not an inconsistency with it. xterm cannot run here because it
 * measures a cell before it can render one and happy-dom performs no layout;
 * CodeMirror renders its document into the DOM without measuring first, so the
 * text is really there to assert against. What still belongs in Playwright is
 * what a mock could never have covered either: colour, scrolling, and selection.
 */

const baseProps = {
  fileKey: 'demo:a.ts',
  value: 'const a = 1;\n',
  languageLoad: null,
  readOnly: true,
  fontFamily: 'monospace',
  fontSize: 13,
  wordWrap: true,
  lineNumbers: true,
  tabWidth: 2,
  onChange: vi.fn(),
  onSave: vi.fn(),
};

const content = (container: HTMLElement) =>
  container.querySelector('.cm-content')?.textContent ?? '';

describe('EditorSurface', () => {
  it('renders the document', () => {
    const { container } = render(<EditorSurface {...baseProps} />);
    expect(content(container)).toContain('const a = 1;');
  });

  it('renders a gutter when line numbers are on, and none when off', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull();

    rerender(<EditorSurface {...baseProps} lineNumbers={false} />);
    expect(container.querySelector('.cm-lineNumbers')).toBeNull();
  });

  /**
   * `readOnly` alone leaves a blinking cursor in a document that swallows every
   * keystroke, which reads as a hung editor rather than a read-only one.
   * `editable` is what removes `contenteditable` with it.
   */
  it('drops contenteditable when read-only, and restores it when not', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    expect(
      container.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ).not.toBe('true');

    rerender(<EditorSurface {...baseProps} readOnly={false} />);
    expect(
      container.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ).toBe('true');
  });

  it('shows new text when the buffer is replaced under the same file', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    rerender(<EditorSurface {...baseProps} value={'const b = 2;\n'} />);

    expect(content(container)).toContain('const b = 2;');
    expect(content(container)).not.toContain('const a = 1;');
  });

  it('swaps documents when the file changes', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    rerender(
      <EditorSurface {...baseProps} fileKey="demo:b.ts" value={'second\n'} />,
    );

    expect(content(container)).toContain('second');
  });

  /**
   * The cache is the reason `EditorState` is kept per file: switching away and
   * back must restore the same document rather than rebuild it.
   */
  it('restores a cached document when switching back', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    rerender(
      <EditorSurface {...baseProps} fileKey="demo:b.ts" value={'second\n'} />,
    );
    rerender(<EditorSurface {...baseProps} />);

    expect(content(container)).toContain('const a = 1;');
  });

  it('reports edits through onChange', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <EditorSurface {...baseProps} readOnly={false} onChange={onChange} />,
    );

    // Dispatched rather than typed: `userEvent` cannot drive a
    // contenteditable's input handling under happy-dom, and the assertion is
    // about the update listener, not about key handling.
    const view = EditorView.findFromDOM(
      container.querySelector('.cm-content') as HTMLElement,
    );

    view?.dispatch({ changes: { from: 0, insert: 'x' } });

    expect(onChange).toHaveBeenCalledWith('xconst a = 1;\n');
  });

  it('mounts with a language loader without waiting for it', () => {
    const languageLoad = vi.fn().mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <EditorSurface {...baseProps} languageLoad={languageLoad} />,
    );

    // The text is on screen before the grammar arrives — the whole point of
    // loading it lazily.
    expect(content(container)).toContain('const a = 1;');
    expect(languageLoad).toHaveBeenCalled();
  });

  /**
   * Click a `.ts` file, click a `.py` file before the first import settles.
   * Without the cancellation guard the first grammar lands in the second
   * document.
   */
  it('ignores a language that resolves after the file changed', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    const { container, rerender, unmount } = render(
      <EditorSurface {...baseProps} languageLoad={first} />,
    );

    rerender(
      <EditorSurface
        {...baseProps}
        fileKey="demo:b.py"
        value={'x = 1\n'}
        languageLoad={null}
      />,
    );

    resolveFirst({});
    await Promise.resolve();

    // Nothing threw, and the second document is still what is on screen.
    expect(content(container)).toContain('x = 1');
    unmount();
  });

  it('rebuilds on a configuration change without losing the text', () => {
    const { container, rerender } = render(<EditorSurface {...baseProps} />);
    rerender(<EditorSurface {...baseProps} fontSize={16} tabWidth={8} />);

    expect(content(container)).toContain('const a = 1;');
  });

  /**
   * **The regression this cache exists for.**
   *
   * A new `EditorState` is built with whatever the compartment is given at
   * construction, and the grammar arrives asynchronously *after* that. Without
   * somewhere to remember it, every rebuild dropped back to plain text — and
   * the watcher's silent reload rebuilds on `value`, which is the feature's
   * headline case. Highlighting used to vanish the first time an agent touched
   * the open file.
   */
  it('keeps its grammar across a reload of the same file', async () => {
    const { javascript } = await import('@codemirror/lang-javascript');
    const languageLoad = vi.fn(async () => javascript({ typescript: true }));

    const { container, rerender } = render(
      <EditorSurface {...baseProps} languageLoad={languageLoad} />,
    );

    await vi.waitFor(() =>
      expect(container.querySelector('.cm-line span')).not.toBeNull(),
    );

    // The watcher's silent reload: same file, new bytes.
    rerender(
      <EditorSurface
        {...baseProps}
        languageLoad={languageLoad}
        value={'const b = 2;\n'}
      />,
    );

    expect(container.querySelector('.cm-line span')).not.toBeNull();
    // Reused, not re-imported.
    expect(languageLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps its grammar across a configuration change', async () => {
    const { javascript } = await import('@codemirror/lang-javascript');
    const languageLoad = vi.fn(async () => javascript({ typescript: true }));

    const { container, rerender } = render(
      <EditorSurface {...baseProps} languageLoad={languageLoad} />,
    );

    await vi.waitFor(() =>
      expect(container.querySelector('.cm-line span')).not.toBeNull(),
    );

    rerender(
      <EditorSurface {...baseProps} languageLoad={languageLoad} fontSize={18} />,
    );

    expect(container.querySelector('.cm-line span')).not.toBeNull();
  });

  it('destroys its view on unmount', () => {
    const { container, unmount } = render(<EditorSurface {...baseProps} />);
    expect(container.querySelector('.cm-editor')).not.toBeNull();

    unmount();
    expect(container.querySelector('.cm-editor')).toBeNull();
  });
});
