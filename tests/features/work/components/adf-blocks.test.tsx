import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdfBlocks } from '@features/work/components/adf-blocks';
import type { AdfBlock } from '@shared/jira-contract';

/**
 * Rendered ADF (HIVE-71).
 *
 * The property that matters most here is the one about what is *not* rendered:
 * a Jira comment is arbitrary text written by anyone with access to the issue,
 * and this component takes text and mark names rather than markup. The last
 * describe block is what would fail if somebody reached for
 * `dangerouslySetInnerHTML`.
 */

const block = (over: Partial<AdfBlock> = {}): AdfBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'hello', marks: [] }],
  ...over,
});

describe('blocks', () => {
  it('renders a paragraph', () => {
    render(<AdfBlocks blocks={[block()]} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('says so when there is nothing to display', () => {
    render(<AdfBlocks blocks={[]} />);
    expect(
      screen.getByText(/nothing this app can display/i),
    ).toBeInTheDocument();
  });

  it('renders a code block as preformatted text', () => {
    render(
      <AdfBlocks
        blocks={[
          {
            kind: 'code',
            language: 'ts',
            runs: [{ text: 'const a = 1;', marks: [] }],
          },
        ]}
      />,
    );

    expect(screen.getByText('const a = 1;').tagName).toBe('PRE');
  });

  it('renders a rule', () => {
    const { container } = render(
      <AdfBlocks blocks={[{ kind: 'rule', runs: [] }]} />,
    );
    expect(container.querySelector('hr')).toBeInTheDocument();
  });

  it('marks list items with a bullet or a dash', () => {
    render(
      <AdfBlocks
        blocks={[
          { kind: 'bullet', runs: [{ text: 'b', marks: [] }], depth: 0 },
          { kind: 'ordered', runs: [{ text: 'o', marks: [] }], depth: 0 },
        ]}
      />,
    );

    expect(screen.getByText('•')).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument();
  });

  it('indents a nested list item', () => {
    render(
      <AdfBlocks
        blocks={[{ kind: 'bullet', runs: [{ text: 'deep', marks: [] }], depth: 2 }]}
      />,
    );

    expect(screen.getByText('deep').closest('p')).toHaveStyle({
      paddingLeft: '34px',
    });
  });
});

describe('runs', () => {
  it('styles each mark it renders', () => {
    render(
      <AdfBlocks
        blocks={[
          {
            kind: 'paragraph',
            runs: [
              { text: 'b', marks: ['strong'] },
              { text: 'i', marks: ['em'] },
              { text: 'c', marks: ['code'] },
              { text: 's', marks: ['strike'] },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('b')).toHaveClass('font-semibold');
    expect(screen.getByText('i')).toHaveClass('italic');
    expect(screen.getByText('c')).toHaveClass('font-mono');
    expect(screen.getByText('s')).toHaveClass('line-through');
  });

  it('renders a run with an href as a link that opens away from the app', () => {
    render(
      <AdfBlocks
        blocks={[
          {
            kind: 'paragraph',
            runs: [
              { text: 'docs', marks: [], href: 'https://example.invalid' },
            ],
          },
        ]}
      />,
    );

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.invalid');
    expect(link).toHaveAttribute('target', '_blank');
    // `noreferrer` implies `noopener`, which is what keeps the opened page from
    // reaching back through `window.opener`.
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});

describe('an unrecognised node still renders', () => {
  it('shows its text, muted', () => {
    render(
      <AdfBlocks
        blocks={[{ kind: 'unknown', runs: [{ text: 'from a panel', marks: [] }] }]}
      />,
    );

    // A comment the app cannot fully render is still a comment to read.
    expect(screen.getByText('from a panel')).toBeInTheDocument();
    expect(screen.getByText('from a panel').closest('p')).toHaveClass(
      'text-subtle',
    );
  });
});

describe('nothing is rendered as markup', () => {
  it('escapes text that looks like HTML', () => {
    const { container } = render(
      <AdfBlocks
        blocks={[
          block({
            runs: [
              {
                text: '<img src=x onerror="alert(1)">',
                marks: [],
              },
            ],
          }),
        ]}
      />,
    );

    // React escapes this, and the point of asserting it here is that the props
    // are `text` and mark *names* — there is no shape in this component's input
    // that could carry markup even if somebody wanted it to.
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getByText('<img src=x onerror="alert(1)">'),
    ).toBeInTheDocument();
  });

  it('escapes a script tag in a code block too', () => {
    const { container } = render(
      <AdfBlocks
        blocks={[
          {
            kind: 'code',
            runs: [{ text: '<script>alert(1)</script>', marks: [] }],
          },
        ]}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
  });
});
