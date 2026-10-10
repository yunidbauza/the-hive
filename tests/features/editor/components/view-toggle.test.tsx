import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewToggle } from '@features/editor/components/view-toggle';
import { useAppearanceStore } from '@stores/appearance-store';
import { fileKey, useEditorStore } from '@stores/editor-store';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
}));

beforeEach(() => {
  readFile.mockResolvedValue({ ok: true, value: { text: '# a\n', mtimeMs: 1, size: 4 } });
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
});

describe('ViewToggle', () => {
  it('is absent for a file with no preview', async () => {
    await act(async () => useEditorStore.getState().openFile('demo', 'src/a.ts'));
    render(<ViewToggle />);
    expect(screen.queryByRole('radiogroup', { name: 'Markdown view' })).toBeNull();
  });

  it('shows the effective view and stores a choice', async () => {
    await act(async () => useEditorStore.getState().openFile('demo', 'README.md'));
    render(<ViewToggle />);
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(
      useEditorStore.getState().openFiles.find((file) => file.key === fileKey('demo', 'README.md'))
        ?.view,
    ).toBe('split');
  });
});
