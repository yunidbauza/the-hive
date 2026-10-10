import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownStage } from '@features/editor/components/markdown-stage';

const { parseMarkdown } = vi.hoisted(() => ({ parseMarkdown: vi.fn() }));
vi.mock('@lib/markdown/parse', () => ({ parseMarkdown }));

const FILE = { projectId: 'demo', relPath: 'README.md', rootKey: '', text: '# a\n' };

beforeEach(() => {
  parseMarkdown.mockReset();
});

describe('MarkdownStage', () => {
  it('falls back to the source, saying so, when the preview cannot parse', async () => {
    parseMarkdown.mockRejectedValue(new Error('chunk failed'));
    render(
      <MarkdownStage file={FILE} view="preview" renderSource={() => <div>source surface</div>} />,
    );
    expect(await screen.findByText('Preview unavailable — showing source.')).toBeInTheDocument();
    expect(screen.getByText('source surface')).toBeInTheDocument();
  });

  it('gives the source its sync props in split, and none in preview', async () => {
    parseMarkdown.mockResolvedValue({ blocks: [] });
    const renderSource = vi.fn(() => <div>source surface</div>);
    const { rerender } = render(
      <MarkdownStage file={FILE} view="split" renderSource={renderSource} />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renderSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ revealLine: null, onTopLineChange: expect.any(Function) }),
    );

    renderSource.mockClear();
    rerender(<MarkdownStage file={FILE} view="preview" renderSource={renderSource} />);
    expect(renderSource).not.toHaveBeenCalled();
  });
});
