import { useEffect, useRef, useState } from 'react';

import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { useNavOrder, useRunOrchCommand } from '@stores/hive-store';
import { useOpenTab, useSelIdx, useSetSelIdx } from '@stores/ui-store';

const PLACEHOLDER = 'help · status · send <session> <message> · spawn <repo> <task>';
const KEY_HINT = '↑↓ select · → open · ↵ run';

/**
 * The orchestrator's command row, and the hint bar under it (story 041).
 *
 * Both are kept, as the concept shows: the input is how you drive the fleet,
 * the hint bar says what the keyboard does and reminds you the console is
 * read-only — the orchestrator works in the background whether or not you type.
 */
export function ConsoleInput() {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const runOrchCommand = useRunOrchCommand();
  const navOrder = useNavOrder();
  const selIdx = useSelIdx();
  const setSelIdx = useSetSelIdx();
  const openTab = useOpenTab();

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

  const openSelected = () => {
    const id = navOrder[selIdx];
    if (id) openTab(id);
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
        <span className="shrink-0 font-mono text-[13px] text-green">
          orchestrator ❯
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          aria-label="Orchestrator command"
          className="min-w-0 flex-1 border-none bg-transparent font-mono text-[12.5px] text-ink caret-green outline-none placeholder:text-subtle"
        />
        <span className="shrink-0 font-mono text-[10.5px] whitespace-nowrap text-subtle">
          {KEY_HINT}
        </span>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-5 border-t border-border-soft bg-term-input px-[18px] py-[11px] font-mono text-[11px] text-subtle">
        <span>↑↓ select</span>
        <span>→ or ↵ open session</span>
        <span>read-only — the orchestrator coordinates in the background</span>
      </div>
    </>
  );
}
