import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownPreview } from '@components/editor/markdown-preview';
import { parseMarkdown } from '@lib/markdown/parse';

const show = async (source: string) => {
  const onOpenLink = vi.fn();
  const doc = await parseMarkdown(source);
  return {
    onOpenLink,
    ...render(<MarkdownPreview doc={doc} fontSize={13} onOpenLink={onOpenLink} />),
  };
};

const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('MarkdownPreview', () => {
  it('renders headings, emphasis, code and lists', async () => {
    await show('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders task items read-only', async () => {
    await show('- [x] done\n- [ ] todo\n');
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('aligns table cells as the separator row says', async () => {
    await show('| a | b |\n|:-|-:|\n| 1 | 2 |\n');
    expect(screen.getByRole('columnheader', { name: 'b' })).toHaveStyle({ textAlign: 'right' });
    expect(screen.getByRole('cell', { name: '2' })).toHaveStyle({ textAlign: 'right' });
  });

  it('marks top-level blocks with their source line', async () => {
    const { container } = await show('# A\n\npara\n');
    expect(
      Array.from(container.querySelectorAll('article > [data-line]')).map((el) =>
        el.getAttribute('data-line'),
      ),
    ).toEqual(['0', '2']);
  });

  it('opens a disclosure from <details>', async () => {
    await show('<details>\n<summary>More</summary>\n\nhidden body\n</details>\n');
    expect(screen.getByText('More').tagName).toBe('SUMMARY');
  });

  /*
    The security property of the whole feature: nothing in the file becomes a
    script, an event handler, a fetched resource or a dangerous link.
  */
  it('shows hostile HTML as text and builds nothing from it', async () => {
    const { container } = await show(
      '<script>alert(1)</script>\n\nx <img src="a.png" alt="A" onerror="boom()"> <a href="javascript:alert(1)">t</a>\n\n<iframe src="https://evil.example"></iframe>\n',
    );
    expect(container.querySelector('script, img, iframe, a')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    for (const element of container.querySelectorAll('*')) {
      for (const name of element.getAttributeNames()) expect(name.startsWith('on')).toBe(false);
    }
  });

  it('shows an image as a placeholder naming it', async () => {
    await show('![board](docs/board.png)\n');
    expect(screen.getByText('board')).toHaveAttribute('title', 'docs/board.png');
  });

  it('opens a relative link through the callback, never as an href', async () => {
    const { onOpenLink, container } = await show('[guide](docs/guide.md)\n');
    await userEvent.click(screen.getByRole('button', { name: 'guide' }));
    expect(onOpenLink).toHaveBeenCalledWith({
      kind: 'relative',
      path: 'docs/guide.md',
      fromRoot: false,
    });
    expect(container.querySelector('a')).toBeNull();
  });

  it('makes an http link a real anchor for the browser', async () => {
    await show('[site](https://example.com/x)\n');
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a refused scheme as plain text', async () => {
    await show('[bad](javascript:alert(1))\n');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('bad')).toBeInTheDocument();
  });

  it('scrolls to the heading an anchor names', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    await show('[down](#the-end)\n\n## The End\n');
    await userEvent.click(screen.getByRole('button', { name: 'down' }));
    expect(scrolled).toEqual([screen.getByRole('heading', { name: 'The End' })]);
  });

  it('survives a document nested thousands of tags deep', async () => {
    const { container } = await show(`x ${'<kbd>'.repeat(5000)}y\n`);
    // Thirty-two real elements; the rest of the tags shown as their own text.
    expect(container.querySelectorAll('kbd')).toHaveLength(32);
    expect(container.textContent).toMatch(/<kbd>y$/);
  });

  it('renders nothing but its frame before the first parse', () => {
    const { container } = render(
      <MarkdownPreview doc={null} fontSize={13} onOpenLink={vi.fn()} />,
    );
    expect(container.querySelector('[data-markdown-preview] article')).toBeEmptyDOMElement();
  });
});

describe('MarkdownPreview — scroll sync', () => {
  /** happy-dom performs no layout, so block geometry is stubbed per element. */
  const layOut = (container: HTMLElement) => {
    container.querySelectorAll<HTMLElement>('article > [data-line]').forEach((block, index) => {
      Object.defineProperty(block, 'offsetTop', { configurable: true, value: index * 100 });
      Object.defineProperty(block, 'offsetHeight', { configurable: true, value: 100 });
    });
    const scroller = container.querySelector<HTMLElement>('[data-markdown-preview]') as HTMLElement;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    return scroller;
  };

  it('scrolls the block at or above the requested line to the top', async () => {
    const doc = await parseMarkdown('# A\n\npara\n\n## B\n'); // lines 0, 2, 4
    const { container, rerender } = render(
      <MarkdownPreview doc={doc} fontSize={13} onOpenLink={vi.fn()} topLine={null} />,
    );
    const scroller = layOut(container);

    rerender(<MarkdownPreview doc={doc} fontSize={13} onOpenLink={vi.fn()} topLine={3} />);
    expect(scroller.scrollTop).toBe(100);
  });

  it('reports the first block still in view as the user scrolls', async () => {
    const onTopLineChange = vi.fn();
    const doc = await parseMarkdown('# A\n\npara\n\n## B\n');
    const { container } = render(
      <MarkdownPreview
        doc={doc}
        fontSize={13}
        onOpenLink={vi.fn()}
        onTopLineChange={onTopLineChange}
      />,
    );
    const scroller = layOut(container);

    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    expect(onTopLineChange).toHaveBeenCalledWith(2);
  });
});
