import { useEffect, useRef, useState, type RefObject } from 'react';

import { KeyHint } from '@components/ui/key-hint';
import { DEMO_PLACEHOLDER, isDesktop } from '@config/runtime';
import { useAutoGrow } from '@hooks/use-auto-grow';
import { isBareBack } from '@lib/terminal/keymap';
import { useSendToEntity } from '@stores/hive-store';
import { useBackToOrch } from '@stores/ui-store';

const PLACEHOLDER = 'message this session — routed by the overmind';

/**
 * `←` from an empty prompt goes back, and that is the only binding this row
 * needs (story 108).
 *
 * It used to carry a second, live-terminal variant that named the `⌘←` chord
 * instead. That variant is unreachable now: the stage renders this row only
 * where the surface above it is a **recording**, because a live session already
 * has Claude's own prompt and a second input beside it is two places to type
 * with no way to tell which has the keyboard. Over a replay, nothing else wants
 * the arrow key.
 */
const HINTS = ['← back to list', '⇧↵ line', '↵ send'];

interface MessageInputProps {
  /** The entity this row talks to. Its id is the prompt label. */
  entityId: string;
  /**
   * Handed down from the stage so a click anywhere in the terminal can focus
   * this input — the concept's behaviour, and the reason the row feels like
   * part of the terminal rather than a form beneath it.
   */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * The message row under a **recorded** session or agent terminal (story 043).
 *
 * This is the product's core promise in one component: a session parked on a
 * question is answered here, and resumes. The round-trip is faked on a timer,
 * but it is *shaped* like the future daemon's — send, acknowledge, work — so
 * the UI code will not change when the backend is real.
 *
 * Story 108 narrowed where it appears rather than what it does. A live desktop
 * session speaks for itself through Claude's own prompt; this row is for the
 * surfaces that cannot — the browser demo and the agent tabs, both replays.
 */
export function MessageInput({ entityId, inputRef }: MessageInputProps) {
  const [value, setValue] = useState('');
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? fallbackRef;

  useAutoGrow(ref, value);

  const sendToEntity = useSendToEntity();
  const backToOrch = useBackToOrch();

  /**
   * Focus on open and after every send. The component is keyed by entity id at
   * the call site, so switching sessions remounts it and re-runs this — which
   * is exactly the "input autofocuses when the view opens" criterion.
   */
  useEffect(() => {
    ref.current?.focus();
  }, [ref]);

  const send = () => {
    const message = value.trim();
    if (message === '') return;

    // Cleared first: the send is fire-and-forget, and leaving the text in place
    // while an acknowledgement is pending invites a double send.
    setValue('');
    sendToEntity(entityId, message, 'session');
    ref.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter') {
      /**
       * `⇧↵` is a line break. Returning without `preventDefault` lets the
       * textarea insert it natively, which keeps undo history, IME composition
       * and the caret position correct — all three of which a manual splice of
       * `value` would quietly get wrong.
       */
      if (event.shiftKey) return;

      event.preventDefault();
      send();
      return;
    }

    /**
     * Only a **bare** `←`, and only with an empty prompt (HIVE-65).
     *
     * The empty-prompt half was always here; the modifier half was not, and its
     * absence meant `⌘←`, `⌥←` and `⇧←` all navigated away from an empty row.
     * Those are text-editing keys — start of line, back one word, extend
     * selection — and a field that answers them by changing screen is a field
     * that punishes muscle memory.
     *
     * Story 110 fixed the same class of bug one surface over, giving `⌘←`/`⌘→`
     * back to the pty as `Home`/`End`; it did not touch this row, which has its
     * own copy of the decision. `isBareBack` is that story's predicate, reused
     * here rather than re-spelled, so the two surfaces cannot drift again.
     */
    if (isBareBack(event) && value === '') {
      event.preventDefault();
      backToOrch();
    }
  };

  return (
    /*
      `items-start`, as in the overmind console: a centred prompt glyph slides
      down the side of a grown message and stops reading as a prompt.
    */
    <div className="flex shrink-0 items-start gap-2.5 border-t border-border-soft bg-term-input px-[18px] py-2.5">
      <span className="shrink-0 font-mono text-[13px] text-green">
        {`${entityId} ❯`}
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        /*
         * The demo surface says what it is (story 083). The row still sends —
         * the fake round-trip is the prototype's core promise and works in both
         * targets — but the transcript underneath it is a recording, and the
         * placeholder is where that stops being a surprise.
         */
        placeholder={isDesktop() ? PLACEHOLDER : DEMO_PLACEHOLDER}
        spellCheck={false}
        aria-label={`Message ${entityId}`}
        /* See the console row: the height is `useAutoGrow`'s to decide. */
        className="min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent font-mono text-[12.5px] leading-normal text-ink caret-green outline-none placeholder:text-subtle"
      />
      <KeyHint hints={HINTS} />
    </div>
  );
}
