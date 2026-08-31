import type { LedgerEntry } from '@shared/ledger-contract';

import { useHiveStore } from '@stores/hive-store';

type AnswerAsk = ReturnType<typeof useHiveStore.getState>['answerAsk'];

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
 * module wholesale.
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
  useHiveStore.getState().hydrateLedger(entries);
  if (overrides.answerAsk !== undefined) {
    useHiveStore.setState({ answerAsk: overrides.answerAsk });
  }
}
