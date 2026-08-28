// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSessionNames } from '../../../../electron/main/notifications/names';

/**
 * Main's copy of what the rail calls each session (HIVE-110).
 *
 * Small enough that the tests are mostly about what it *refuses*: it exists
 * because the previous holder of this fact — a map fed from the raw terminal
 * title — was confidently wrong, and the only defence left in main is the one
 * below.
 */
describe('session names', () => {
  it('answers with the terminal id until something reports a name', () => {
    const names = createSessionNames();

    expect(names.get('sess-11')).toBe('sess-11');
  });

  it('answers with the reported name', () => {
    const names = createSessionNames();

    names.set('sess-11', 'mutex-explanation');

    expect(names.get('sess-11')).toBe('mutex-explanation');
  });

  it('follows a rename', () => {
    const names = createSessionNames();

    names.set('sess-11', 'mutex-explanation');
    names.set('sess-11', 'HIVE-110-inbox-names');

    expect(names.get('sess-11')).toBe('HIVE-110-inbox-names');
  });

  /*
    An empty name is the absence of one, not a rename to nothing — storing it
    would blank the name in every toast that followed.
  */
  it('ignores an empty name rather than blanking a good one', () => {
    const names = createSessionNames();

    names.set('sess-11', 'mutex-explanation');
    names.set('sess-11', '');

    expect(names.get('sess-11')).toBe('mutex-explanation');
  });

  it('keeps sessions apart', () => {
    const names = createSessionNames();

    names.set('sess-10', 'current-time');
    names.set('sess-11', 'mutex-explanation');

    expect(names.get('sess-10')).toBe('current-time');
    expect(names.get('sess-11')).toBe('mutex-explanation');
  });
});
