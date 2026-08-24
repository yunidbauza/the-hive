import { useEffect, useRef, useState } from 'react';

import { PROJECT_KEY_HINT, isProjectKey } from '@shared/config-contract';

interface ProjectKeyEditorProps {
  initialKey: string;
  /**
   * Every key already spoken for, mapped to the project holding it — and
   * **excluding this project's own**.
   *
   * A map rather than a set so the refusal can name the culprit: "already used"
   * asks the user to go hunting, where "already used by APFM Web" is a row they
   * can go and look at. Passed in rather than read here because only
   * `projects-list.tsx` can see the other rows, and this editor fetching its
   * own list would be a second source of truth for the same fact.
   */
  takenKeys: ReadonlyMap<string, string>;
  /** Called only with a valid, unused key that differs from the current one. */
  onCommit: (key: string) => void;
  onCancel: () => void;
}

/**
 * Edit a project's typing alias in place (HIVE-94).
 *
 * A sibling of `project-name-editor.tsx` and deliberately built the same way —
 * focused and selected on the next frame, blur commits, Escape cancels and says
 * so by being a key you had to press. Read that file for why each of those is
 * what it is; the reasons are identical and are not repeated here.
 *
 * ## What this one adds: a rule the user can fail
 *
 * A name cannot really be wrong. A key can be — too long, not letters, or
 * already someone else's — so this editor validates as you type and shows why,
 * where the name editor just takes what it is given.
 *
 * The hint line does double duty: at rest it *teaches* the rule
 * (`2–4 lowercase letters · Enter to save`), and on a bad value it becomes the
 * refusal. One line rather than two means the row does not change height as the
 * user types, and the place they are already looking is the place the answer
 * appears.
 *
 * ## Why an invalid value cannot be committed at all
 *
 * Blur commits, which is the right default for a field someone has typed into —
 * but "commit" for an invalid key would mean a refusal arriving from main after
 * the editor had already closed, with the reason in a snapshot error nothing on
 * this row renders. So an invalid value cancels instead: nothing is written,
 * the chip is unchanged, and the user has lost a keystroke rather than a
 * mystery. Main still refuses a duplicate independently — the config is not
 * watched, so this check is the courtesy and that one is the gate.
 */
export function ProjectKeyEditor({
  initialKey,
  takenKeys,
  onCommit,
  onCancel,
}: ProjectKeyEditorProps) {
  const input = useRef<HTMLInputElement>(null);
  /** Set by Escape so the blur it causes does not then commit. */
  const cancelled = useRef(false);
  const [draft, setDraft] = useState(initialKey);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  /*
    Lowercased as it is typed rather than rejected for being uppercase. Keys are
    lowercase by definition, so a capital is a shift key that was still down —
    a slip, not an intent, and correcting it silently is what the user meant.
  */
  const value = draft.trim().toLowerCase();
  const owner = takenKeys.get(value);
  const problem = !isProjectKey(value)
    ? PROJECT_KEY_HINT
    : owner !== undefined
      ? `already used by ${owner}`
      : null;

  const commit = () => {
    if (cancelled.current) return;
    if (problem !== null || value === initialKey) {
      onCancel();
      return;
    }
    onCommit(value);
  };

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <input
        ref={input}
        /*
          Claims Escape from the settings dialog. Radix decides on a
          document-capture listener, before the key reaches this input, so the
          overlay consults this attribute instead — see `settings-overlay.tsx`.
        */
        data-escape-scope=""
        aria-label="Project key"
        aria-invalid={problem !== null}
        value={draft}
        /*
          Four characters is the whole rule, so the field is the size of the
          thing it holds. A full-width input for a four-letter value would
          suggest there is more to type.
        */
        maxLength={4}
        size={4}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            // Stops bubble-phase ancestors seeing it; `data-escape-scope` is
            // what keeps the settings dialog itself open.
            event.stopPropagation();
            cancelled.current = true;
            onCancel();
          }
        }}
        className={`w-14 rounded-[5px] border bg-bg px-1.5 py-0.5 text-center font-mono text-[12px] lowercase text-ink ${
          problem === null ? 'border-brand-fill' : 'border-red'
        }`}
      />
      <span
        className={`whitespace-nowrap text-[10.5px] ${
          problem === null ? 'text-subtle' : 'text-red'
        }`}
      >
        {problem ?? `${PROJECT_KEY_HINT} · Enter to save`}
      </span>
    </div>
  );
}
