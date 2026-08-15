// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `theme:pick` and `theme:save` (HIVE-80).
 *
 * The dialog is mocked — a unit test must never pop a real native dialog —
 * but the read and write themselves run against a real temp directory, the
 * same discipline `fs/write.test.ts` uses: a filesystem call is worth
 * exercising for real rather than trusting a mock of `node:fs/promises` to
 * agree with what `readFile`/`writeFile` actually do.
 */

const showOpenDialog = vi.fn();
const showSaveDialog = vi.fn();
const fromWebContents = vi.fn(() => ({ id: 1 }));

vi.mock('electron', () => ({
  dialog: { showOpenDialog, showSaveDialog },
  BrowserWindow: { fromWebContents },
}));

const { pickTheme, saveTheme, parseSaveThemeRequest } = await import(
  '../../../../electron/main/theme'
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-theme-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('theme:pick', () => {
  it('filters to .json and resolves null when cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    expect(await pickTheme({ sender: {} } as never)).toBeNull();
    expect(showOpenDialog.mock.calls[0][1].filters).toEqual([
      { name: 'Hive theme', extensions: ['json'] },
    ]);
  });

  it('resolves null when there is no window for the sender', async () => {
    fromWebContents.mockReturnValueOnce(null as never);

    expect(await pickTheme({ sender: {} } as never)).toBeNull();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('reads the chosen file and returns its path and contents', async () => {
    const path = join(root, 'picked.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, '{"hiveThemeVersion":1}', 'utf8');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });

    const result = await pickTheme({ sender: {} } as never);

    expect(result).toEqual({ path, contents: '{"hiveThemeVersion":1}' });
  });
});

describe('theme:save', () => {
  it('resolves null when cancelled and writes nothing', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    expect(
      await saveTheme({ sender: {} } as never, {
        suggestedName: 'x.json',
        contents: '{}',
      }),
    ).toBeNull();
    expect(showSaveDialog).toHaveBeenCalled();
  });

  it('resolves null when there is no window for the sender', async () => {
    fromWebContents.mockReturnValueOnce(null as never);

    expect(
      await saveTheme({ sender: {} } as never, {
        suggestedName: 'x.json',
        contents: '{}',
      }),
    ).toBeNull();
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('offers the suggested name as the default path', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await saveTheme(
      { sender: {} } as never,
      { suggestedName: 'my-theme.json', contents: '{}' },
    );

    expect(showSaveDialog.mock.calls[0][1]).toMatchObject({
      defaultPath: 'my-theme.json',
      filters: [{ name: 'Hive theme', extensions: ['json'] }],
    });
  });

  it('writes the contents to the chosen path and resolves it', async () => {
    const path = join(root, 'saved.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path });

    const result = await saveTheme({ sender: {} } as never, {
      suggestedName: 'saved.json',
      contents: '{"hiveThemeVersion":1}',
    });

    expect(result).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('{"hiveThemeVersion":1}');
  });

  it('writes nothing when the dialog resolves an empty path', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' });

    expect(
      await saveTheme({ sender: {} } as never, {
        suggestedName: 'x.json',
        contents: '{}',
      }),
    ).toBeNull();
  });
});

describe('parseSaveThemeRequest', () => {
  it('accepts a well-formed request', () => {
    expect(
      parseSaveThemeRequest({ suggestedName: 'my-theme.json', contents: '{}' }),
    ).toEqual({ suggestedName: 'my-theme.json', contents: '{}' });
  });

  it('rejects a non-object payload', () => {
    expect(() => parseSaveThemeRequest(null)).toThrow();
    expect(() => parseSaveThemeRequest('nope')).toThrow();
    expect(() => parseSaveThemeRequest(['x'])).toThrow();
  });

  it('rejects an unexpected key', () => {
    expect(() =>
      parseSaveThemeRequest({
        suggestedName: 'x.json',
        contents: '{}',
        path: '/etc/passwd',
      }),
    ).toThrow(/unexpected key/);
  });

  it('rejects a prototype-polluting key', () => {
    expect(() =>
      parseSaveThemeRequest(
        JSON.parse('{"__proto__": {"polluted": true}, "suggestedName": "x.json", "contents": "{}"}'),
      ),
    ).toThrow(/forbidden key/);
  });

  it('rejects contents that are not a string', () => {
    expect(() =>
      parseSaveThemeRequest({ suggestedName: 'x.json', contents: 42 }),
    ).toThrow(/contents/);
  });

  it('rejects contents over the byte cap', async () => {
    const { MAX_THEME_BYTES } = await import(
      '../../../../electron/shared/theme-contract'
    );
    expect(() =>
      parseSaveThemeRequest({
        suggestedName: 'x.json',
        contents: 'x'.repeat(MAX_THEME_BYTES + 1),
      }),
    ).toThrow(/limit/);
  });

  it('rejects a suggestedName that is not a bare .json filename', () => {
    expect(() =>
      parseSaveThemeRequest({ suggestedName: '../../etc/passwd', contents: '{}' }),
    ).toThrow(/suggestedName/);
    expect(() =>
      parseSaveThemeRequest({ suggestedName: 'theme.txt', contents: '{}' }),
    ).toThrow(/suggestedName/);
    expect(() =>
      parseSaveThemeRequest({ suggestedName: '', contents: '{}' }),
    ).toThrow(/suggestedName/);
  });
});
