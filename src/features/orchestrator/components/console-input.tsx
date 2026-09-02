import { useEffect, useRef, useState } from 'react';

import { ADVERTISED_VERBS } from '@/types/command';

import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { effectiveSelId } from '@features/orchestrator/utils/selection';
import { useAutoGrow } from '@hooks/use-auto-grow';
import {
  useNavOrder,
  openOrResume,
  useRunOrchCommand,
} from '@stores/hive-store';
import { useSelId, useSetSelId } from '@stores/ui-store';

const KEY_HINT = '↑↓ select · → open · ⇧↵ line · ↵ run';

/**
 * The overmind's command row, and the hint bar under it (story 041).
 *
 * Both are kept, as the concept shows: the input is how you drive the fleet, and
 * the hint bar says what the keyboard does.
 *
 * ## The prompt carries no placeholder
 *
 * It used to print a curated subset of the grammar — `help · status · send …`
 * — which was the same fact the hint bar prints in full one row beneath, and
 * a second, shorter copy of a list is not a second piece of information. It
 * also had a hard length budget, because it was the placeholder of a textarea
 * that auto-grows to its content: a string long enough to wrap made the
 * *empty* console two rows tall and took that row out of the terminal above.
 * Removing it removes the budget, and leaves the row reading as what it is —
 * a prompt, with the grammar under it where `ADVERTISED_VERBS` keeps it.
 *
 * ## Why the third hint is the grammar and no longer "read-only" (HIVE-93)
 *
 * It used to read `read-only — the orchestrator coordinates in the background`,
 * which spent the one remaining slot in the bar on a reassurance nobody needed:
 * the console is visibly a prompt, and "it works whether or not you type" is not
 * something a user is worried about. Worse, "read-only" is now simply wrong —
 * `send` and `spawn` both act on the fleet from this row.
 *
 * The verbs go there instead, because the grammar was otherwise discoverable
 * only by typing `help` — which you have to already know exists. Listing them is
 * the cheapest possible fix for that and costs no extra height.
 */
export function ConsoleInput() {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutoGrow(inputRef, value);

  const runOrchCommand = useRunOrchCommand();
  const navOrder = useNavOrder();
  const selId = useSelId();
  const setSelId = useSetSelId();

  /**
   * Focus on mount so the arrow keys work without a click first. Story 060
   * takes over global key handling; until then this row is the only thing
   * listening, and an unfocused input would make the documented shortcuts a
   * lie.
   */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const move = (delta: number) => {
    if (navOrder.length === 0) return;
    /**
     * The position is looked up **now**, from the id, rather than being carried
     * between keystrokes.
     *
     * That is the whole of the id-keyed selection: `navOrder` is sorted by
     * recency, so a row's index is a fact about the current fleet and not about
     * the caret. Resolving it per keystroke means a session that spawned or
     * ended since the last one moves the *rows* without moving the selection.
     *
     * The two "no caret" states differ, and `effectiveSelId` is what separates
     * them. Nothing chosen yet is the first row — the state a fresh launch is
     * in, and the one the old index-based selection expressed as `0`. A chosen
     * row that has since aged out of the fleet is genuinely nowhere: `indexOf`
     * answers `-1`, and the key heads for the end it was already going to —
     * the top on `↓` without a special case, the bottom on `↑`, which needs
     * the guard or `-1 - 1` clamps back to the top and the key does nothing.
     */
    const at =
      selId === null ? 0 : navOrder.indexOf(effectiveSelId(selId, navOrder) ?? '');
    const from = at === -1 && delta < 0 ? navOrder.length : at;
    // Clamped, not wrapped: running off the end of a list and reappearing at
    // the other end loses the user's place.
    const next = Math.min(Math.max(from + delta, 0), navOrder.length - 1);
    setSelId(navOrder[next] ?? null);
  };

  /**
   * `→` and `↵` open the selected row — through the domain gate, so a
   * terminated session is declined here exactly as it is on click (story 108).
   *
   * `openOrResume` rather than `openEntity` (HIVE-93): every ended row is now
   * refused by the gate, and a row that *can* be resumed has a control saying
   * so. Routing the keyboard through `openEntity` alone would mean a user could
   * arrow onto a finished session, press Enter, and get silence — with the
   * resume button reachable only by mouse.
   */
  const openSelected = () => {
    const id = effectiveSelId(selId, navOrder);
    if (id !== null && navOrder.includes(id)) openOrResume(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /**
     * Once the row occupies more than one **visual** row, `↑`/`↓` are caret
     * motion again.
     *
     * The same shape as the `→` guard below — *only take a key when there is
     * nothing to move through* — and it is what keeps this row from becoming
     * the trap it was built to avoid: a field you can type into but cannot move
     * the caret back up through. Single-line content, which is every command
     * the console had before, is untouched.
     *
     * Measured rather than read off the text, because `value.includes('\n')`
     * answers a different question than the one being asked. A long command
     * with no newline in it **soft-wraps** onto a second row, and the caret then
     * has somewhere to go that the string knows nothing about — so keying on
     * `\n` re-created the exact trap this guard exists to prevent, for input as
     * ordinary as a long `spawn` task. `scrollHeight` is what the user can
     * actually see.
     */
    const el = inputRef.current;
    const multiline =
      value.includes('\n') ||
      (el !== null &&
        el.scrollHeight > Number.parseFloat(getComputedStyle(el).lineHeight) * 1.5);

    switch (event.key) {
      case 'ArrowUp':
        if (multiline) return;
        event.preventDefault();
        move(-1);
        return;

      case 'ArrowDown':
        if (multiline) return;
        event.preventDefault();
        move(1);
        return;

      case 'ArrowRight':
        // Only when there is nothing to move the caret through — otherwise this
        // would hijack ordinary text editing.
        if (value !== '') return;
        event.preventDefault();
        openSelected();
        return;

      case 'Enter': {
        /**
         * `⇧↵` is a line break, and the check comes first for a reason: with an
         * empty row the branch below would have opened the selected session
         * instead, so a user starting a multi-line message with a blank first
         * line would have been thrown into a terminal. Returning without
         * `preventDefault` hands the key back to the textarea, which inserts
         * the newline itself — the browser is better at that than we are, and
         * it keeps undo, IME composition and the caret position correct.
         */
        if (event.shiftKey) return;

        event.preventDefault();
        if (value === '') {
          openSelected();
          return;
        }
        runOrchCommand(parseCommand(value));
        setValue('');
      }
    }
  };

  return (
    <>
      {/*
        `items-start` rather than `items-center`: once the textarea grows, a
        centred prompt glyph drifts down the side of the message and stops
        reading as a prompt. Pinned to the top it stays where the first line is.
      */}
      <div className="flex shrink-0 items-start gap-2.5 border-t border-border-soft bg-term-input px-[18px] py-2.5">
        {/*
          The prompt glyph — the most visible instance of the name, and the one
          the string inventory nearly missed, because it is bare JSX text rather
          than a quoted literal. The test below greps the rendered output for
          `/orchestrator/i` precisely so a seventh copy cannot hide the same way.
        */}
        <span className="shrink-0 font-mono text-[13px] text-green">
          overmind ❯
        </span>
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          aria-label="Overmind command"
          /*
           * `resize-none` because the height is ours to decide (`useAutoGrow`),
           * and a drag handle in the corner of a terminal prompt would fight it.
           * `leading-normal` so the computed line height the hook measures is a
           * real number rather than the `normal` keyword.
           */
          className="min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent font-mono text-[12.5px] leading-normal text-ink caret-green outline-none placeholder:text-subtle"
        />
        <span className="shrink-0 pt-px font-mono text-[10.5px] whitespace-nowrap text-subtle">
          {KEY_HINT}
        </span>
      </div>

      {/*
        The verbs, and only the verbs.

        This bar used to open with `↑↓ select` and `→ or ↵ open session`, and
        `KEY_HINT` prints `↑↓ select · → open` in the input row's right corner a
        few pixels above — the same fact twice, which at a narrow stage was what
        wrapped this row onto two lines.

        One thing did go with them, and it is worth naming rather than glossing:
        `KEY_HINT` says `↵ run`, not that `↵` on an *empty* row opens the
        selected session. That branch is real (see `onKeyDown`) and is now
        undocumented on screen. It is the cheaper half of the trade — the keys
        it shares with `→`, which is documented — but it is a trade, not a free
        removal.

        The verb list stays because nothing else says it. It is the only place
        the grammar is visible without already knowing that `help` exists.

        `ADVERTISED_VERBS`, not `CONSOLE_VERBS`: the grammar has a verb it
        parses but does not teach — see `QUIET_VERBS` in `types/command.ts`.
      */}
      <div
        /*
          The last thing on the stage, and `fleet-scroll.spec.ts` reads it as
          exactly that: it proves the fleet table never grows until the console
          is pushed past the foot of the window. It used to find this bar by
          its `↑↓ select` span, which no longer exists — a text locator for a
          string that has moved is a spec that silently stops testing anything.
        */
        data-testid="console-hints"
        className="flex shrink-0 items-center justify-center border-t border-border-soft bg-term-input px-[18px] py-[11px] font-mono text-[11px] text-subtle"
      >
        <span>{ADVERTISED_VERBS.join(' · ')}</span>
      </div>
    </>
  );
}
