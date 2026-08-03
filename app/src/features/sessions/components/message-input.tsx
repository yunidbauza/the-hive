import { useEffect, useRef, useState, type RefObject } from 'react';

import { DEMO_PLACEHOLDER, isDesktop } from '@config/runtime';
import { useSendToEntity } from '@stores/hive-store';
import { useBackToOrch } from '@stores/ui-store';

const PLACEHOLDER = 'message this session — routed by the orchestrator';
const KEY_HINT = '← back to list · ↵ send';

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
      <span className="shrink-0 font-mono text-[10.5px] whitespace-nowrap text-subtle">
        {KEY_HINT}
      </span>
    </div>
  );
}
