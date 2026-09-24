// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  legacyBase,
  readHistory,
  type History,
} from '../../../../electron/main/seed/history';
import { baseOf, hashPart, mergeParts } from '../../../../electron/main/seed/merge';

/**
 * A `~/.hive` seeded before the part manifest has no base for its files. The
 * shipped history gives it one: the version the file came from, with any
 * part that still matches some shipped version counted as untouched.
 */

const file = (lines: string[], body = 'v1\n'): string => `---\n${lines.join('\n')}\n---\n${body}`;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const version = (text: string) => ({ file: sha(text), ...baseOf(text) });

const REL = 'agents/shipper/AGENT.md';
const v1 = file(['name: shipper', 'model: opus', 'limits:', '  turns: 60', '  daily_usd: 40']);
const v2 = file(['name: shipper', 'model: sonnet', 'limits:', '  turns: 60', '  daily_usd: 40'], 'v2\n');
const v3 = file(['name: shipper', 'model: sonnet', 'lane: repo', 'limits:', '  turns: 60', '  daily_usd: 40'], 'v3\n');
const history: History = { [REL]: [version(v1), version(v2), version(v3)] };

describe('legacyBase', () => {
  it('takes the version a v1 manifest hash names', () => {
    const mine = file(['name: shipper', 'model: haiku', 'limits:', '  turns: 60', '  daily_usd: 40'], 'v2\n');

    expect(legacyBase(REL, mine, sha(v2), history)?.body).toBe(hashPart('v2\n'));
  });

  it('without a manifest hash, takes the version agreeing on the most parts', () => {
    // v2's body, no `lane`, `daily_usd` deleted: v2 is the best match.
    const mine = file(['name: shipper', 'model: sonnet', 'limits:', '  turns: 100'], 'v2\n');
    const base = legacyBase(REL, mine, undefined, history);

    expect(base?.body).toBe(hashPart('v2\n'));
    expect(base?.keys.lane).toBeUndefined();
    // Deleted by the user, so it stays deleted.
    expect(base?.keys['limits.daily_usd']).toBe(hashPart('  daily_usd: 40'));
  });

  it('on a tie, does not read a key only the newest tied version has as deleted', () => {
    // v1-era keys, an edited model and body: every version agrees on the same three parts.
    const mine = file(['name: shipper', 'model: haiku', 'limits:', '  turns: 60', '  daily_usd: 40'], 'Mine.\n');
    const base = legacyBase(REL, mine, undefined, history);

    // `lane` arrived in v3; the file may simply predate it, so it arrives rather than stays deleted.
    expect(base?.keys.lane).toBeUndefined();
    expect(mergeParts(mine, v3, base).text).toContain('lane: repo');
  });

  it('on a tie, still reads a key every tied version has as deleted', () => {
    const mine = file(['name: shipper', 'model: haiku', 'limits:', '  turns: 60'], 'Mine.\n');
    const base = legacyBase(REL, mine, undefined, history);

    expect(base?.keys['limits.daily_usd']).toBe(hashPart('  daily_usd: 40'));
    expect(mergeParts(mine, v3, base).text).not.toContain('daily_usd');
  });

  it('counts a part matching any shipped version as untouched', () => {
    // v3's body, but v1's model: the model is an old shipped value, not an edit.
    const mine = file(['name: shipper', 'model: opus', 'lane: repo', 'limits:', '  turns: 60', '  daily_usd: 40'], 'v3\n');

    expect(legacyBase(REL, mine, undefined, history)?.keys.model).toBe(hashPart('model: opus'));
  });

  it('has no base for a file the history never saw', () => {
    expect(legacyBase('agents/mine/AGENT.md', v1, undefined, history)).toBeNull();
  });
});

describe('readHistory', () => {
  it('reads the index, and treats a missing or broken one as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-history-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');

    await writeFile(good, JSON.stringify(history));
    await writeFile(bad, '{ nope');

    expect(await readHistory(good)).toEqual(history);
    expect(await readHistory(bad)).toEqual({});
    expect(await readHistory(join(dir, 'absent.json'))).toEqual({});
    await rm(dir, { recursive: true, force: true });
  });
});
