import { useState } from 'react';

import { InlineConfirm } from '@features/settings/components/inline-confirm';
import type { ShippedStatus } from '@shared/shipped-contract';

/**
 * How Settings shows a shipped agent or skill the user changed.
 *
 * Three marks, and only one asks for anything. The **dot** in the list says
 * the user changed it: brand for their own settings, which still take every
 * update around them; amber for a held prompt. The **strip** over the editor
 * names what differs and holds Reset to shipped. The **banner** appears only
 * for a held prompt, the one state in which the agent runs instructions the
 * app has since replaced, so it is the one that asks for a choice.
 *
 * Each takes `undefined` for "as shipped" and draws nothing, so the panes can
 * mount them unconditionally.
 */

const BUTTON =
  'shrink-0 rounded-md border border-border px-2 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-ink';

export function ShippedDot({ status }: { status: ShippedStatus | undefined }) {
  if (status === undefined) return null;

  const label = status.held
    ? 'A newer shipped prompt is waiting'
    : 'Changed from the shipped version';

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`size-1.5 shrink-0 rounded-full ${status.held ? 'bg-amber' : 'bg-brand'}`}
    />
  );
}

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** What a reset throws away, one change after another. */
function losses(status: ShippedStatus): string {
  const lines = status.customised.map(
    (part) => `${part.path}: ${part.yours} → ${part.shipped ?? 'removed'}`,
  );

  if (status.bodyEdited) lines.push('your prompt edits');
  if (status.files.length > 0) lines.push(`your edits to ${status.files.join(', ')}`);

  return `${lines.join('; ')}.`;
}

export function ShippedStrip({
  status,
  onReset,
  onKeepMine,
}: {
  status: ShippedStatus | undefined;
  onReset: () => void;
  onKeepMine: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (status === undefined) return null;

  const { customised, moved, files } = status;
  const summary = [
    customised.length > 0
      ? `${plural(customised.length, 'setting')} differ${customised.length === 1 ? 's' : ''} from shipped: ${customised.map((part) => part.path).join(', ')}.`
      : null,
    status.bodyEdited ? 'Your prompt.' : 'The prompt follows updates.',
    files.length > 0 ? `Edited files: ${files.join(', ')}.` : null,
    moved.length > 0 ? `Shipped value moved: ${moved.join(', ')}.` : null,
  ].filter((part) => part !== null);

  return (
    <div className="flex flex-col overflow-hidden rounded-[7px] border border-border-soft">
      <div className="flex flex-col gap-1 bg-brand/8 px-3 py-1.5 text-[11.5px] text-muted">
        <div className="flex items-center gap-1.5">
          <span className="mr-auto font-medium text-brand">● Customised</span>
          {moved.length > 0 ? (
            <button type="button" onClick={onKeepMine} className={BUTTON}>
              Keep mine
            </button>
          ) : null}
          <button type="button" onClick={() => setConfirming(true)} className={BUTTON}>
            Reset to shipped
          </button>
        </div>
        <p>{summary.join(' ')}</p>
      </div>
      {confirming ? (
        <InlineConfirm
          label={`Reset ${status.name} to the shipped version?`}
          title={`Reset ${status.name} to the shipped version?`}
          confirmLabel="Reset"
          cancelLabel="Keep editing"
          escape="document"
          className="border-t border-border-soft"
          onConfirm={() => {
            setConfirming(false);
            onReset();
          }}
          onCancel={() => setConfirming(false)}
        >
          You lose {losses(status)}
        </InlineConfirm>
      ) : null}
    </div>
  );
}

export function HeldBanner({
  status,
  onTake,
  onKeep,
}: {
  status: ShippedStatus | undefined;
  onTake: () => void;
  onKeep: () => void;
}) {
  const [comparing, setComparing] = useState(false);

  if (status === undefined || !status.held) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-[7px] border border-amber/40 bg-amber/8 px-3 py-2 text-[11.5px] text-ink">
      <span>
        <span className="font-medium text-amber">Update held.</span> A newer shipped prompt for{' '}
        {status.name} is waiting, but the one here has your edits. Until you choose, {status.name} runs
        your version.
      </span>
      <span className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-expanded={comparing}
          onClick={() => setComparing((open) => !open)}
          className={BUTTON}
        >
          Compare
        </button>
        <button
          type="button"
          onClick={onTake}
          className="shrink-0 rounded-md border border-amber/60 px-2 py-0.5 text-[11.5px] text-amber hover:bg-hover"
        >
          Take shipped prompt
        </button>
        <button type="button" onClick={onKeep} className={BUTTON}>
          Keep mine
        </button>
      </span>
      {comparing ? (
        <pre className="max-h-64 overflow-auto rounded-[5px] border border-border-soft bg-bg px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
          {status.shippedBody.trim()}
        </pre>
      ) : null}
    </div>
  );
}
