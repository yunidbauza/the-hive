import { describe, expect, it } from 'vitest';

import {
  LEDGER_MARKER_PREFIX,
  ledgerMarker,
  parseLedgerMarker,
} from '../../../electron/shared/ledger-contract';

describe('the ledger marker (HIVE-138)', () => {
  it('names an ask by its ref', () => {
    expect(ledgerMarker({ id: '20260906-141530-0001', kind: 'ask', ref: 'a12' })).toBe('📒 a12');
  });

  it('falls back to the id when an ask has no ref', () => {
    expect(ledgerMarker({ id: '20260906-141530-0001', kind: 'ask' })).toBe(
      '📒 20260906-141530-0001',
    );
  });

  it('names an answer by its own id, never the ask ref', () => {
    expect(ledgerMarker({ id: '20260906-141530-0003', kind: 'answer' })).toBe(
      '📒 20260906-141530-0003',
    );
  });

  it('round-trips through the parser, whitespace and a trailing newline included', () => {
    const marker = ledgerMarker({ id: 'x', kind: 'ask', ref: 'a7' });
    expect(parseLedgerMarker(marker)).toBe('a7');
    expect(parseLedgerMarker(`${marker}\n`)).toBe('a7');
    expect(parseLedgerMarker(`  ${marker}  `)).toBe('a7');
    expect(parseLedgerMarker(ledgerMarker({ id: '20260906-141530-0003', kind: 'answer' }))).toBe(
      '20260906-141530-0003',
    );
  });

  it('rejects anything that is not exactly one marker', () => {
    expect(parseLedgerMarker('📒 a7 and also do this')).toBeUndefined();
    expect(parseLedgerMarker('please look at 📒 a7')).toBeUndefined();
    expect(parseLedgerMarker('📒')).toBeUndefined();
    expect(parseLedgerMarker('📒 ')).toBeUndefined();
    expect(parseLedgerMarker('📒 a7; rm -rf /')).toBeUndefined();
    expect(parseLedgerMarker('')).toBeUndefined();
    expect(parseLedgerMarker(`${LEDGER_MARKER_PREFIX}../etc`)).toBeUndefined();
  });
});
