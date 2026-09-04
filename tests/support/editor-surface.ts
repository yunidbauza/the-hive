import { EditorView } from '@codemirror/view';
import { act, screen } from '@testing-library/react';

/**
 * Reading and writing an `EditorSurface` from a unit test.
 *
 * A textarea answers `toHaveValue` and `userEvent.clear`; CodeMirror answers
 * neither, and the reason is not that it is hard to drive but that it is not a
 * form control at all. Its document lives in an `EditorState`, and the DOM
 * under `.cm-content` is a *rendering* of that state — line divs with no
 * newline characters between them, and only the visible ones once a document
 * grows past a screen. So `textContent` is the wrong thing to assert on twice
 * over: it joins `a\nb` into `ab`, and it silently omits whatever is scrolled
 * out of view.
 *
 * These go through the view instead, which is the same surface CodeMirror's own
 * tests use. AGENTS.md is explicit that CodeMirror is never mocked — it renders
 * for real in happy-dom — so this is a helper for reaching the real thing, not
 * a stand-in for it.
 */

/**
 * The live view behind the surface with this accessible name.
 *
 * Named rather than "the only editor on screen", because a pane can hold more
 * than one and a test that grabbed the first would pass for the wrong reason.
 */
export function surfaceView(name: string): EditorView {
  const content = screen.getByRole('textbox', { name });
  const view = EditorView.findFromDOM(content as HTMLElement);

  if (view === null) {
    throw new Error(
      `"${name}" is a textbox, but no CodeMirror view is mounted on it.`,
    );
  }

  return view;
}

/** The whole document, newlines and all — what `toHaveValue` used to give. */
export function surfaceText(name: string): string {
  return surfaceView(name).state.doc.toString();
}

/**
 * Replace the document, as a paste over a select-all would.
 *
 * `act`, because the change reaches React through the surface's `onChange` and
 * the state it sets is what the assertions then read.
 */
export function setSurfaceText(name: string, text: string): void {
  const view = surfaceView(name);

  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}
