import { useEffect, useRef, useState } from 'react';

import { CONSOLE_VERBS } from '@/types/command';

import { parseCommand } from '@features/orchestrator/utils/parse-command';
import {
  useNavOrder,
  useOpenEntity,
  useRunOrchCommand,
} from '@stores/hive-store';
import { useSelIdx, useSetSelIdx } from '@stores/ui-store';

const PLACEHOLDER = 'help · status · send <session> <message> · spawn <repo> <task>';
const KEY_HINT = '↑↓ select · → open · ↵ run';

/**
 * The overmind's command row, and the hint bar under it (story 041).
 *
 * Both are kept, as the concept shows: the input is how you drive the fleet, and
 * the hint bar says what the keyboard does.
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
  const inputRef = useRef<HTMLInputElement>(null);

  const runOrchCommand = useRunOrchCommand();
  const navOrder = useNavOrder();
  const selIdx = useSelIdx();
  const setSelIdx = useSetSelIdx();
  const openEntity = useOpenEntity();

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
    // Clamped, not wrapped: running off the end of a list and reappearing at
    // the other end loses the user's place.
    const next = Math.min(Math.max(selIdx + delta, 0), navOrder.length - 1);
    setSelIdx(next);
  };

  /**
   * `→` and `↵` open the selected row — through the domain gate, so a
   * terminated session is declined here exactly as it is on click (story 108).
   */
  const openSelected = () => {
    const id = navOrder[selIdx];
    if (id) openEntity(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;

      case 'ArrowDown':
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
      <div className="flex shrink-0 items-center gap-2.5 border-t border-border-soft bg-term-input px-[18px] py-2.5">
        {/*
          The prompt glyph — the most visible instance of the name, and the one
          the string inventory nearly missed, because it is bare JSX text rather
          than a quoted literal. The test below greps the rendered output for
          `/orchestrator/i` precisely so a seventh copy cannot hide the same way.
        */}
        <span className="shrink-0 font-mono text-[13px] text-green">
          overmind ❯
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          aria-label="Overmind command"
          className="min-w-0 flex-1 border-none bg-transparent font-mono text-[12.5px] text-ink caret-green outline-none placeholder:text-subtle"
        />
        <span className="shrink-0 font-mono text-[10.5px] whitespace-nowrap text-subtle">
          {KEY_HINT}
        </span>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-5 border-t border-border-soft bg-term-input px-[18px] py-[11px] font-mono text-[11px] text-subtle">
        <span>↑↓ select</span>
        <span>→ or ↵ open session</span>
        <span>{CONSOLE_VERBS.join(' · ')}</span>
      </div>
    </>
  );
}
