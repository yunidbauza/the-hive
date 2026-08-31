import type { LedgerEntry } from '@shared/ledger-contract';

import { useHiveStore } from '@stores/hive-store';

type AnswerAsk = ReturnType<typeof useHiveStore.getState>['answerAsk'];

/**
 * The store's real `answerAsk`, captured before any case can replace it.
 *
 * `reset()` re-seeds the **data** fields and leaves the actions alone, which
 * is right for the store and is why the spy this module installs used to
 * outlive the case that asked for one: the next case to click a button without
 * an override went on asserting against the previous case's mock, and the doc
 * below promising "as if it were the only one that ever ran" was not true.
 *
 * Read once, at module load, so it is the genuine action rather than whatever
 * the last case left behind — and restored on every call, not only when an
 * override is given, because it is the *absence* of an override that the
 * leak made unsafe.
 */
const REAL_ANSWER_ASK: AnswerAsk = useHiveStore.getState().answerAsk;

/**
 * Put a thread into the store, for a test that renders {@link AskCard} or
 * anything else reading `useThread`.
 *
 * `reset()` first, always — `hydrateLedger` **merges**, which is right for the
 * app (the push channel can beat `list()` home) and wrong for a test file: two
 * cases in the same suite reusing an id (`'a41'`, answered by `'x2'`) would
 * otherwise see the *first* case's entry win, because a merge skips an id it
 * has already seen. Resetting first is what lets every case seed its own
 * thread as if it were the only one that ever ran.
 *
 * `overrides.answerAsk`, when given, replaces the store's real action after
 * the reset — the same direct-`setState` idiom `seedDemoFleet` uses for its
 * slices — so a test can hand `AskCard` a spy without mocking the store
 * module wholesale. When it is *not* given, {@link REAL_ANSWER_ASK} is put
 * back, which is what makes the sentence above true of the action as well as
 * of the data.
 *
 * @param entries The thread's entries — the ask and, optionally, its answer.
 * @param overrides `answerAsk`, to assert what a click sent without a real
 *   `window.hive` bridge.
 */
export function seedLedger(
  entries: LedgerEntry[],
  overrides: { answerAsk?: AnswerAsk } = {},
): void {
  useHiveStore.getState().reset();
  useHiveStore.setState({ answerAsk: overrides.answerAsk ?? REAL_ANSWER_ASK });
  useHiveStore.getState().hydrateLedger(entries);
}
