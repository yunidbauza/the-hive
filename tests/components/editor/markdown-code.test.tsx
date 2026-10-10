import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownCode } from '@components/editor/markdown-code';

describe('MarkdownCode', () => {
  it('shows the text at once, then highlights it once the grammar arrives', async () => {
    const { container } = render(<MarkdownCode lang="ts" text="const a = 1;" line={4} />);

    expect(container.querySelector('code')).toHaveTextContent('const a = 1;');
    expect(container.querySelector('pre')).toHaveAttribute('data-line', '4');
    await waitFor(() =>
      expect(container.querySelector('.text-code-keyword')).toHaveTextContent('const'),
    );
    expect(screen.getByText('ts')).toBeInTheDocument();
  });

  it('accepts the fence names people write, not just extensions', async () => {
    const { container } = render(<MarkdownCode lang="typescript" text="const a = 1;" />);
    await waitFor(() => expect(container.querySelector('.text-code-keyword')).not.toBeNull());
  });

  it('leaves an unknown language as plain text', () => {
    const { container } = render(<MarkdownCode lang="klingon" text="qapla'" />);
    expect(container.querySelector('code')).toHaveTextContent("qapla'");
    expect(container.querySelector('code span')).toBeNull();
  });
});
