import { useEffect, useRef } from 'react';

interface ProjectNameEditorProps {
  initialName: string;
  /** Called only with a trimmed, non-empty name that differs from the current one. */
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Edit a project's display name in place (story 103).
 *
 * The "is this worth writing?" rule lives here rather than in each caller: a
 * blank name and an unchanged name are both cancels, so nothing downstream has
 * to re-derive that. The guard in main rejects a blank name too — this is the
 * convenience, not the gate.
 *
 * Blur commits rather than discarding. Clicking away from a field you have
 * typed into should not silently throw the edit away; Escape is the discard,
 * and it says so by being a key you had to press.
 */
export function ProjectNameEditor({
  initialName,
  onCommit,
  onCancel,
}: ProjectNameEditorProps) {
  const input = useRef<HTMLInputElement>(null);
  /**
   * Set by Escape so the blur it causes does not then commit.
   *
   * A ref rather than state: blur runs before any re-render would deliver a new
   * value, so state would still read `false` at the moment it matters — and the
   * cancel would be undone by the very event it caused.
   */
  const cancelled = useRef(false);

  useEffect(() => {
    /*
      Focused and selected on mount, in an effect rather than via `autoFocus`.
      The prop is banned by `jsx-a11y/no-autofocus` — rightly, because it
      usually means a page steals focus on load. This is the opposite case: the
      input exists only because the user just chose "Rename…", so focus is what
      they asked for, and an input they have to click to use would be a bug.

      Selected, not merely focused: the common edit replaces a name derived from
      the directory basename outright, which should not need a Cmd+A first.

      **On the next frame, not synchronously.** This editor is opened from a
      Radix menu item, and Radix moves focus as its menu unmounts — after this
      effect runs. Focusing synchronously means the input holds focus for that
      teardown, gets blurred by it, and blur on an unchanged name is a cancel:
      the editor would close before a key was ever pressed. Waiting a frame lets
      the menu finish, so there is no focus for it to take away.
    */
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const commit = () => {
    if (cancelled.current) return;
    const next = input.current?.value.trim() ?? '';
    if (next === '' || next === initialName) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={input}
      /*
        Claims Escape from the settings dialog. Radix decides on a
        document-capture listener, before the key reaches this input, so the
        overlay consults this attribute instead — see `settings-overlay.tsx`.
      */
      data-escape-scope=""
      aria-label="Project name"
      defaultValue={initialName}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          /*
            Stops bubble-phase ancestors seeing it. This is *not* what keeps the
            settings dialog open — Radix decides on a document-capture listener
            that runs before this handler, so that half is handled by the
            `data-escape-scope` attribute below.
          */
          event.stopPropagation();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="w-full rounded-[5px] border border-brand-fill bg-bg px-1.5 py-0.5 text-[13px] text-ink"
    />
  );
}
