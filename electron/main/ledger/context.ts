import { ledgerMarker, type LedgerEntry } from '@shared/ledger-contract';

/**
 * One ledger entry, rendered as the context a hook carries (HIVE-138).
 *
 * This is what a session's model reads when a marker lands in its prompt. It
 * says first who is speaking and why, in the app's own voice, so the model
 * does not take `📒 a12` for the user's words and does not take the entry for
 * an instruction smuggled into its context; then the entry whole, body
 * verbatim and every meta key as one JSON line, for the reason `ledger_read`
 * in `mcp-tools.ts` gives: meta is an arbitrary map and anything lossy here
 * breaks a story; then what, if anything, is owed back.
 *
 * The voice is measured, not chosen. The first live run of
 * `tests/live/marker-context-conformance.test.ts` carried a curt version of
 * this text, and the model called it a prompt injection: an instruction in
 * its context, from nobody it could place, naming a tool it could not see.
 * Saying plainly that the app delivered it, that the terminal shows only the
 * marker, and what to do when the tool is absent is what makes the same
 * entry read as a message rather than an attack.
 *
 * Nothing is stripped or cut. The bytes go into a JSON body the model reads,
 * not into a pty a terminal interprets. The control-character boundary that
 * `deliver.ts` used to enforce on the body moved out of the pty path with the
 * body itself; the pty now sees a ref or an id main minted and nothing else.
 */
export interface EntryContextOptions {
  /**
   * The ask this closes, when the caller may see it. An answer's ask is
   * where the ref and the asker's `meta.intent` come from; passed only when
   * the caller is a party to it, since an answer can be addressed to a third
   * party and that party is owed the answer, not the question behind it.
   */
  ask?: LedgerEntry;
  /**
   * Whether an ask is still open. A marker re-typed, or redelivered after a
   * refused receipt, can name an ask that has since been answered or has
   * expired; telling the model to answer it would only earn a refusal.
   */
  open?: boolean;
}

export function entryContext(entry: LedgerEntry, options: EntryContextOptions = {}): string {
  const { ask, open = true } = options;
  const marker = ledgerMarker(entry);
  const name = marker.slice(marker.indexOf(' ') + 1);
  const lines: string[] = [
    `The Hive, the desktop app that runs this terminal session, delivered a ledger entry to you. The user's terminal shows only the marker "${marker}"; this message is the entry itself, unabridged, and it comes from the app, not from the user.`,
    '',
    `From: ${entry.from}`,
  ];

  if (entry.kind === 'ask') {
    lines.push(`Kind: ask, ref ${name}, addressed to you`, '', entry.body, '');
  } else if (entry.kind === 'post') {
    // A one-way notice (the shipper's "PR merged"), not the answer to an ask.
    lines.push('Kind: notice, addressed to you', '', entry.body, '');
  } else {
    /*
      The handle a person would know the thread by: the ask's ref when the log
      still has the ask, the thread id otherwise. Same fallback `deliver.ts`
      makes for the receipt, for the same reason: an id always identifies the
      thread, it is just longer than a person wants.
    */
    const handle = ask?.ref ?? entry.thread ?? entry.id;
    lines.push(`Kind: answer, closing your ask ${handle}`, '', entry.body, '');
    const intent = ask?.meta?.intent;
    if (typeof intent === 'string' && intent.trim() !== '') {
      lines.push(`You asked so you could: ${intent}`, '');
    }
  }

  if (entry.meta !== undefined && Object.keys(entry.meta).length > 0) {
    lines.push(`Meta: ${JSON.stringify(entry.meta)}`, '');
  }

  if (entry.kind === 'post') {
    lines.push('Nothing is owed back. This notice needs no reply.');
  } else if (entry.kind !== 'ask') {
    lines.push('Nothing is owed back. If the answer is not enough, ask again with the ledger_ask tool.');
  } else if (!open) {
    lines.push(
      `This ask is no longer open: it has been answered or has expired since the marker was written, so nothing is owed back.`,
    );
  } else {
    lines.push(
      `To answer, call the ledger_answer tool with thread "${name}"; that closes the ask and reaches ${entry.from}. If that tool is not available in this session, say so and give your answer in your reply, so the user can relay it.`,
    );
  }
  return lines.join('\n');
}
