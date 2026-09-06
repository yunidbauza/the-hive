import { ledgerMarker, type LedgerEntry } from '@shared/ledger-contract';

/**
 * One ledger entry, rendered as the context a hook carries (HIVE-138).
 *
 * This is what a session's model reads when a marker lands in its prompt. It
 * says first that the marker was the app's doing, so the model does not take
 * `📒 a12` for the user's words; then the entry whole, body verbatim and every
 * meta key as one JSON line, for the reason `ledger_read` in `mcp-tools.ts`
 * gives: meta is an arbitrary map and anything lossy here breaks a story;
 * then what, if anything, is owed back.
 *
 * Nothing is stripped or cut. The bytes go into a JSON body the model reads,
 * not into a pty a terminal interprets. The control-character boundary that
 * `deliver.ts` used to enforce on the body moved out of the pty path with the
 * body itself; the pty now sees a ref or an id main minted and nothing else.
 */
export function entryContext(entry: LedgerEntry, ask?: LedgerEntry): string {
  const marker = ledgerMarker(entry);
  const name = marker.slice(marker.indexOf(' ') + 1);
  const lines: string[] = [
    `The line "${marker}" was written into this session by The Hive. It is not the user's words; it marks ledger entry ${name}, carried here in full.`,
    '',
  ];

  if (entry.kind === 'ask') {
    lines.push(`${entry.from} asks you (${name}):`, '', entry.body, '');
  } else {
    /*
      The handle a person would know the thread by: the ask's ref when the log
      still has the ask, the thread id otherwise. Same fallback `deliver.ts`
      makes for the receipt, for the same reason: an id always identifies the
      thread, it is just longer than a person wants.
    */
    const handle = ask?.ref ?? entry.thread ?? entry.id;
    lines.push(`${entry.from} answered your ask ${handle}:`, '', entry.body, '');
    const intent = ask?.meta?.intent;
    if (typeof intent === 'string' && intent.trim() !== '') {
      lines.push(`You asked so you could: ${intent}`, '');
    }
  }

  if (entry.meta !== undefined && Object.keys(entry.meta).length > 0) {
    lines.push(`meta: ${JSON.stringify(entry.meta)}`, '');
  }

  lines.push(
    entry.kind === 'ask'
      ? `Reply with the ledger_answer tool, thread "${name}". Your answer closes the ask and reaches ${entry.from}.`
      : 'Nothing is owed back. Ask again with ledger_ask if the answer is not enough.',
  );
  return lines.join('\n');
}
