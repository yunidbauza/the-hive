// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { readFrontmatter } from '../../../../electron/main/agents/definition';
import { patchFrontmatter } from '../../../../electron/main/agents/patch';

const SOURCE = `---
name: slack-watcher
description: Watches #incorp-dev and my mentions.
icon: ChatCircleDots                # a Phosphor name
wake:
  every: 5m                         # floor 1m
  on: [ledger]
autonomy: ask                       # ask | act
limits:
  turns: 40
---
You are the Slack watcher.
`;

describe('patchFrontmatter', () => {
  it('replaces only the value token, leaving the comment', () => {
    expect(patchFrontmatter(SOURCE, 'autonomy', 'act')).toContain(
      'autonomy: act                       # ask | act',
    );
  });

  it('patches a nested key', () => {
    const next = patchFrontmatter(SOURCE, 'wake.every', '15m');

    expect(readFrontmatter(next)?.fields.get('wake.every')?.value).toBe('15m');
    expect(next).toContain('# floor 1m');
  });

  it('holds the comment column steady when the value changes width', () => {
    // A longer value that pushed its trailing comment right would ripple the
    // whole aligned block out of true on every edit.
    const columnOf = (text: string, key: string) => {
      const line = text.split('\n').find((l) => l.trim().startsWith(key));

      return line === undefined ? -1 : line.indexOf('#');
    };

    const wider = patchFrontmatter(SOURCE, 'wake.every', '15m');
    const narrower = patchFrontmatter(SOURCE, 'wake.every', '1h');

    expect(columnOf(wider, 'every:')).toBe(columnOf(SOURCE, 'every:'));
    expect(columnOf(narrower, 'every:')).toBe(columnOf(SOURCE, 'every:'));
  });

  it('keeps a two-space gap when the value outgrows the padding entirely', () => {
    // Past the comment's original column there is nothing left to reclaim, so
    // the gap bottoms out rather than going negative and gluing value to hash.
    const long = 'x'.repeat(40);
    const next = patchFrontmatter(SOURCE, 'wake.every', long);

    expect(next).toContain(`${long}  # floor 1m`);
  });

  it('leaves every other line byte-identical', () => {
    const before = SOURCE.split('\n');
    const after = patchFrontmatter(SOURCE, 'autonomy', 'act').split('\n');

    expect(after).toHaveLength(before.length);

    for (const [i, line] of before.entries()) {
      if (line.startsWith('autonomy:')) continue;

      expect(after[i], `line ${i} moved`).toBe(line);
    }
  });

  it('leaves the body untouched', () => {
    expect(patchFrontmatter(SOURCE, 'autonomy', 'act')).toContain(
      'You are the Slack watcher.',
    );
  });

  it('keeps a value that itself contains a single-space #', () => {
    const next = patchFrontmatter(SOURCE, 'description', 'Watches #hive and me.');

    expect(readFrontmatter(next)?.fields.get('description')?.value).toBe(
      'Watches #hive and me.',
    );
  });

  it('inserts a top-level key that is absent, before the closing fence', () => {
    const next = patchFrontmatter(SOURCE, 'model', 'opus');

    expect(readFrontmatter(next)?.fields.get('model')?.value).toBe('opus');
  });

  it('inserts a nested key into its existing block, indented', () => {
    const next = patchFrontmatter(SOURCE, 'wake.quiet', '23:00-07:00');

    expect(next).toContain('  quiet: 23:00-07:00');
    expect(readFrontmatter(next)?.fields.get('wake.quiet')?.value).toBe(
      '23:00-07:00',
    );
  });

  it('adds to an existing block without opening a second one', () => {
    const next = patchFrontmatter(SOURCE, 'wake.quiet', '23:00-07:00');

    expect(next.split('\n').filter((line) => line.trim() === 'wake:')).toHaveLength(
      1,
    );
  });

  it('opens the parent block when it does not exist yet', () => {
    const bare = `---
name: quiet-one
description: Nothing.
icon: Ghost
---
Body.
`;
    const next = patchFrontmatter(bare, 'limits.turns', '12');

    expect(readFrontmatter(next)?.fields.get('limits.turns')?.value).toBe('12');
  });

  it('round-trips: patching a value back returns the original text', () => {
    const there = patchFrontmatter(SOURCE, 'autonomy', 'act');

    expect(patchFrontmatter(there, 'autonomy', 'ask')).toBe(SOURCE);
  });

  it('joins a parent block whose own line carries a comment', () => {
    /*
      The reader recognises `wake:  # …` as an open block through
      `stripComment`; the patcher compared the raw line and did not, so it
      spliced a *second* `wake:` before the fence. The reader still parsed the
      result — later keys win — so the file was silently corrupted.
    */
    const commented = SOURCE.replace('wake:', 'wake:   # when to run');
    const next = patchFrontmatter(commented, 'wake.quiet', '23:00-07:00');

    expect(
      next.split('\n').filter((line) => line.trim().startsWith('wake:')),
    ).toHaveLength(1);
    expect(readFrontmatter(next)?.fields.get('wake.quiet')?.value).toBe(
      '23:00-07:00',
    );
    expect(readFrontmatter(next)?.fields.get('wake.every')?.value).toBe('5m');
  });

  it('keeps the comment on a key that had no value yet', () => {
    // The whole gap sat between the colon and the `#`, so the comment looked
    // like the value and was overwritten. This is the shape the pane's own
    // new-agent template produces.
    const empty = `---
name: a
description: d
icon: Ghost
model:        # pick one later
---
Body.
`;
    const next = patchFrontmatter(empty, 'model', 'sonnet');

    expect(readFrontmatter(next)?.fields.get('model')?.value).toBe('sonnet');
    expect(next).toContain('# pick one later');
  });

  it('is a no-op for a file with no closing fence', () => {
    const broken = '---\nname: x\n';

    expect(patchFrontmatter(broken, 'autonomy', 'act')).toBe(broken);
  });

  it('does not reach past the fence into the body', () => {
    const shadowed = `---
name: a
---
autonomy: ask
`;
    const next = patchFrontmatter(shadowed, 'autonomy', 'act');

    // The body's look-alike line is prose, not frontmatter: it must not move,
    // and the real key gets inserted above the fence instead.
    expect(next).toContain('\nautonomy: ask\n');
    expect(readFrontmatter(next)?.fields.get('autonomy')?.value).toBe('act');
  });
});
