import { useEffect, useRef, useState, type RefObject } from 'react';

import { KeyHint } from '@components/ui/key-hint';
import { DEMO_PLACEHOLDER, isDesktop } from '@config/runtime';
import { isMacPlatform } from '@lib/platform';
import { backChordLabel, isBackChord } from '@lib/terminal/keymap';
import { isLiveTerminal } from '@lib/terminal/resolve-transport';
import { useSendToEntity } from '@stores/hive-store';
import { useBackToOrch } from '@stores/ui-store';

const PLACEHOLDER = 'message this session — routed by the orchestrator';

interface MessageInputProps {
  /** The entity this row talks to. Its id is the prompt label. */
  entityId: string;
  /**
   * Handed down from the stage so a click anywhere in the terminal can focus
   * this input — the concept's behaviour, and the reason the row feels like
   * part of the terminal rather than a form beneath it.
   */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The message row under a session or agent terminal (story 043).
 *
 * This is the product's core promise in one component: a session parked on a
 * question is answered here, and resumes. The round-trip is faked on a timer,
 * but it is *shaped* like the future daemon's — send, acknowledge, work — so
 * the UI code will not change when the backend is real.
 */
export function MessageInput({ entityId, inputRef }: MessageInputProps) {
  const [value, setValue] = useState('');
  const fallbackRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? fallbackRef;

  const sendToEntity = useSendToEntity();
  const backToOrch = useBackToOrch();

  /**
   * The hint tells the truth about *this* surface.
   *
   * Over a recorded transcript, `←` from an empty prompt goes back — the row
   * owns the keyboard because nothing else wants it. Over a live terminal the
   * user's focus is usually in the terminal, where `←` is a cursor key the
   * child process needs, so the way back is a chord (story 095).
   *
   * Bare `←` *does* now go back from inside a live terminal, but only at an
   * empty Claude prompt (`isEmptyClaudePrompt`), and the hint still names the
   * chord rather than the arrow. The chord is the binding that always works —
   * mid-message, in a shell, in `vim` — and a hint that advertised `←` would be
   * wrong in every one of those places. Claude draws its own `← 2 agents`
   * affordance when the arrow is live, which is the right surface for it.
   */
  const live = isLiveTerminal(entityId);
  const hints = live
    ? [`${backChordLabel(isMacPlatform())} back to list`, '↵ send']
    : ['← back to list', '↵ send'];

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

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }

    // Only with an empty prompt — otherwise this would hijack ordinary editing.
    if (event.key === 'ArrowLeft' && value === '') {
      event.preventDefault();
      backToOrch();
      return;
    }

    /**
     * The terminal's chord works from this row too, so the hint above is true
     * wherever the user is reading it (story 095).
     *
     * This is the one text field in the app that accepts it, and it is a narrow,
     * deliberate trade: `Cmd+←` is natively "caret to start of line", which
     * matters little in a single-line prompt that already treats a leftward key
     * as "go back". Nothing else in the app overrides it — that was the bug this
     * replaced.
     */
    if (live && isBackChord(event, isMacPlatform())) {
      event.preventDefault();
      backToOrch();
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-border-soft bg-term-input px-[18px] py-2.5">
      <span className="shrink-0 font-mono text-[13px] text-green">
        {`${entityId} ❯`}
      </span>
      <input
        ref={ref}
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
        className="min-w-0 flex-1 border-none bg-transparent font-mono text-[12.5px] text-ink caret-green outline-none placeholder:text-subtle"
      />
      <KeyHint hints={hints} />
    </div>
  );
}
