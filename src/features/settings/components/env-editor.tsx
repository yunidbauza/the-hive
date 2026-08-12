import { Plus, Trash } from '@phosphor-icons/react';
import { useState } from 'react';

import { unsafeEnvReason } from '@shared/config-contract';

/**
 * Per-project environment variables (story 104).
 *
 * A list of name/value rows rather than a free-text blob. A textarea would be
 * fewer components and would push every parsing decision — quoting, escapes,
 * line continuations — onto a format nobody specified, and the guard in main
 * would then reject the result with a message about a key the user never
 * typed as a key.
 *
 * Local draft state, committed explicitly. Each save is a whole-file atomic
 * write, so committing per keystroke would mean one write per character.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface EnvEditorProps {
  value: Record<string, string>;
  onSave: (env: Record<string, string>) => void;
  disabled?: boolean;
}

interface Row {
  /**
   * Identity for React, separate from `key` (the variable name).
   *
   * The variable name cannot serve as the React key: it is edited character by
   * character, so every keystroke would remount the input and lose focus. The
   * array index cannot either — deleting a row would shift every later row's
   * key and hand the wrong draft value to the wrong input.
   */
  rowId: number;
  key: string;
  value: string;
}

let nextRowId = 0;
const makeRow = (key = '', value = ''): Row => ({
  rowId: (nextRowId += 1),
  key,
  value,
});

const toRows = (env: Record<string, string>): Row[] =>
  Object.entries(env).map(([key, value]) => makeRow(key, value));

/**
 * Why a row cannot be saved, or `null`.
 *
 * Mirrors the guard in `guards.ts` deliberately — the same three rules, in the
 * same order. This is not the enforcement (main's guard is), it is the
 * explanation, delivered before a round trip that would otherwise fail with a
 * thrown channel error the user cannot read.
 */
function rowError(row: Row, rows: Row[], index: number): string | null {
  if (row.key === '') return null; // A blank row is simply not saved.
  if (!ENV_NAME.test(row.key)) {
    return `"${row.key}" is not a valid variable name`;
  }
  // The refusal list is shared with both guards, so the explanation shown here
  // is the same sentence main would answer with.
  const unsafe = unsafeEnvReason(row.key);
  if (unsafe !== null) return unsafe;
  if (rows.some((other, at) => at !== index && other.key === row.key)) {
    return `${row.key} is listed twice`;
  }
  return null;
}

export function EnvEditor({ value, onSave, disabled = false }: EnvEditorProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));

  /**
   * Deduplicated, because a duplicate name is an error on *both* rows.
   *
   * Without this the same sentence renders twice — and, since the message is
   * the React key, with a colliding key. Saying "FOO is listed twice" twice is
   * also just worse writing than saying it once.
   */
  const errors = [
    ...new Set(
      rows
        .map((row, index) => rowError(row, rows, index))
        .filter((error): error is string => error !== null),
    ),
  ];

  const update = (index: number, patch: Partial<Row>) => {
    setRows((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  };

  const save = () => {
    // Blank names are dropped rather than rejected: an empty row is what a
    // half-finished thought looks like, not an error worth blocking a save for.
    const env: Record<string, string> = {};
    for (const row of rows) {
      if (row.key !== '') env[row.key] = row.value;
    }
    onSave(env);
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-subtle">
          No variables. Sessions in this project inherit your environment.
        </p>
      ) : null}

      {rows.map((row, index) => (
        <div key={row.rowId} className="flex items-center gap-2">
          <input
            type="text"
            value={row.key}
            aria-label={`Variable ${index + 1} name`}
            placeholder="NAME"
            disabled={disabled}
            onChange={(event) => update(index, { key: event.target.value })}
            className="w-[168px] rounded-[6px] border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-subtle focus-visible:ring-1 focus-visible:ring-brand"
          />
          <input
            type="text"
            value={row.value}
            aria-label={`Variable ${index + 1} value`}
            placeholder="value"
            disabled={disabled}
            onChange={(event) => update(index, { value: event.target.value })}
            className="min-w-0 flex-1 rounded-[6px] border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-subtle focus-visible:ring-1 focus-visible:ring-brand"
          />
          <button
            type="button"
            aria-label={`Remove variable ${index + 1}`}
            disabled={disabled}
            onClick={() =>
              setRows((current) => current.filter((_, at) => at !== index))
            }
            className="rounded p-1.5 text-subtle hover:bg-hover hover:text-red"
          >
            <Trash size={13} />
          </button>
        </div>
      ))}

      {errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setRows((current) => [...current, makeRow()])}
          className="flex items-center gap-1.5 rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          <Plus size={12} weight="bold" />
          Add variable
        </button>

        <button
          type="button"
          // Blocked on a real error, never on "nothing changed": comparing
          // against the saved map would make the button lie after an
          // out-of-band edit to the config file.
          disabled={disabled || errors.length > 0}
          onClick={save}
          className="rounded-[6px] bg-brand-fill px-2.5 py-1 text-[12px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-50"
        >
          Save variables
        </button>
      </div>
    </div>
  );
}
