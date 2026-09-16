import { describe, expect, it, vi } from 'vitest';

import {
  createFileLinkProvider,
  type FileLink,
  type FileLinkProviderOptions,
} from '@lib/terminal/file-links';

/**
 * The provider half: which candidates become links, and what opens one.
 *
 * Split from `file-links.test.ts` because the questions are different in kind
 * — that file is a table of real compiler output, this one is about a round
 * trip, a memo and a modifier. Nothing here renders a terminal; the buffer is
 * a `readLine` the test supplies, which is the whole reason the provider takes
 * one.
 */

const LINES = [' ❯ src/a.ts:12:7 and src/gone.ts', 'nothing here'];

/**
 * A line as xterm holds it: the text, and where each character of it is
 * actually **drawn**.
 *
 * The default here is the all-narrow case, where the two coincide — which is
 * exactly the assumption that made the wide-character bug invisible.
 */
const narrow = (text: string) => ({
  text,
  columns: Array.from({ length: text.length + 1 }, (_unused, i) => i),
});

function provider(over: Partial<FileLinkProviderOptions> = {}) {
  const resolve = vi.fn(async (paths: string[]) =>
    paths.map((path) =>
      path === 'src/a.ts' ? { relPath: 'src/a.ts', rootKey: '' } : null,
    ),
  );
  const open = vi.fn();
  const built = createFileLinkProvider({
    readLine: (y) => {
      const text = LINES[y - 1];
      return text === undefined ? undefined : narrow(text);
    },
    resolve,
    open,
    isModified: (event) => event.metaKey,
    ...over,
  });

  const links = (y: number): Promise<FileLink[] | undefined> =>
    new Promise((done) => {
      built.provideLinks(y, done);
    });

  return { resolve, open, links };
}

describe('createFileLinkProvider', () => {
  it('asks main for the bare paths and links only what it accepts', async () => {
    const { resolve, links } = provider();
    const result = await links(1);

    // The position is stripped before the round trip: main resolves a file.
    expect(resolve).toHaveBeenCalledWith(['src/a.ts', 'src/gone.ts']);
    expect(result?.map((link) => ({ text: link.text, range: link.range }))).toEqual([
      { text: 'src/a.ts:12:7', range: { start: { x: 4, y: 1 }, end: { x: 16, y: 1 } } },
    ]);
  });

  it('answers undefined for a line with nothing in it, without a round trip', async () => {
    const { resolve, links } = provider();
    expect(await links(2)).toBeUndefined();
    expect(await links(99)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('opens with the position, and only under the modifier', async () => {
    const { open, links } = provider();
    const [link] = (await links(1)) ?? [];

    link?.activate(new MouseEvent('click'), link.text);
    expect(open).not.toHaveBeenCalled();

    link?.activate(new MouseEvent('click', { metaKey: true }), link.text);
    expect(open).toHaveBeenCalledWith({
      relPath: 'src/a.ts',
      rootKey: '',
      line: 12,
      col: 7,
    });
  });

  it('remembers a line by its text, so scrolling back never re-asks', async () => {
    const { resolve, links } = provider();
    await links(1);
    await links(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  /**
   * A hover is a mouse movement, not a request. A resolver that is down must
   * not turn one into an error the user has to dismiss — the text simply does
   * not underline.
   */
  it('treats a rejected resolve as no links', async () => {
    const { links } = provider({ resolve: () => Promise.reject(new Error('down')) });
    expect(await links(1)).toBeUndefined();
  });

  it('forwards hover and leave with the link text', async () => {
    const hover = vi.fn();
    const leave = vi.fn();
    const { links } = provider({ hover, leave });
    const [link] = (await links(1)) ?? [];

    link?.hover?.(new MouseEvent('mousemove'), link.text);
    link?.leave?.(new MouseEvent('mousemove'), link.text);
    // The event rides along from HIVE's tooltip: the pointer is the only
    // thing that knows where the link is on screen.
    expect(hover).toHaveBeenCalledWith('src/a.ts:12:7', expect.any(MouseEvent));
    expect(leave).toHaveBeenCalled();
  });
});

/**
 * A double-width character before the path.
 *
 * xterm draws CJK, most emoji and some box-drawing glyphs in **two** columns
 * while `translateToString` returns them as one JS character. So every string
 * index after one of them undercounts the real column, and a range built from
 * string offsets drifts left of the path it is supposed to underline — the
 * user sees a link they cannot click, with nothing on screen explaining why.
 *
 * Claude Code's own output is full of these, which is what makes it the
 * ordinary case rather than an exotic one.
 */
describe('wide characters', () => {
  const linkFrom = async (text: string, columns: number[]) => {
    const built = createFileLinkProvider({
      readLine: (y) => (y === 1 ? { text, columns } : undefined),
      resolve: async (paths) =>
        paths.map((path) => ({ relPath: path, rootKey: '' })),
      open: vi.fn(),
      isModified: () => true,
    });
    const links = await new Promise<FileLink[] | undefined>((done) => {
      built.provideLinks(1, done);
    });
    return links?.[0];
  };

  /**
   * `名` is drawn in two columns, so `src/a.ts` starts at column 3 while its
   * string index is 2. Built from string offsets the range would be 3..10 —
   * one column left of the path, every character of it.
   */
  it('places the range where the path is drawn, not where its string index falls', async () => {
    //            名  ' '  s  r  c  /  a  .  t   s  (end)
    const columns = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const link = await linkFrom('名 src/a.ts', columns);

    expect(link?.text).toBe('src/a.ts');
    expect(link?.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 11, y: 1 } });
  });

  /** Two of them: the drift accumulates, so the range must too. */
  it('accumulates the drift across several wide characters', async () => {
    //            ✅ ' ' ✅ ' '  s  r  c  /   a   .   t   s  (end)
    const columns = [0, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const link = await linkFrom('✅ ✅ src/a.ts', columns);

    expect(link?.text).toBe('src/a.ts');
    expect(link?.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 14, y: 1 } });
  });

  /**
   * One cell, two string characters — a combining accent, or an emoji built
   * from several code units. Here the space after the path shares the `s`'s
   * cell, so reading `columns[end]` would report that cell's own start and cut
   * the last character out of the range.
   */
  it('does not end the range early when the next character shares a cell', async () => {
    //             a  .  t  s ' ' (end)
    const columns = [0, 1, 2, 3, 3, 4];
    const link = await linkFrom('a.ts ', columns);

    expect(link?.text).toBe('a.ts');
    expect(link?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 4, y: 1 } });
  });
});
