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
 * agree with what `readFile`/`writeFile`/`stat` actually do.
 *
 * `node:fs/promises` is still partially mocked, but only to wrap `readFile`
 * in a spy while forwarding every call to the real implementation — the
 * point is not to fake a read, it is to prove `pickTheme` never *makes* one
 * for a file the size check has already refused.
 */

const showOpenDialog = vi.fn();
const showSaveDialog = vi.fn();
const fromWebContents = vi.fn(() => ({ id: 1 }));

vi.mock('electron', () => ({
  dialog: { showOpenDialog, showSaveDialog },
  BrowserWindow: { fromWebContents },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const { pickTheme, saveTheme, parseSaveThemeRequest } = await import(
  '../../../../electron/main/theme'
);
const { MAX_THEME_BYTES } = await import(
  '../../../../electron/shared/theme-contract'
);
const { readFile: readFileSpy } = await import('node:fs/promises');

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

  /**
   * `canceled: false` with an empty `filePaths` is not a shape the real
   * dialog is documented to return, but nothing in this module assumes
   * otherwise — the `path === undefined` branch exists precisely to treat it
   * the same as a cancel rather than crash on `result.filePaths[0]`.
   */
  it('resolves null when not cancelled but no path was chosen', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });

    expect(await pickTheme({ sender: {} } as never)).toBeNull();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('reads the chosen file and returns its path and contents', async () => {
    const path = join(root, 'picked.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, '{"hiveThemeVersion":1}', 'utf8');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });

    const result = await pickTheme({ sender: {} } as never);

    expect(result).toEqual({ path, contents: '{"hiveThemeVersion":1}' });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The Important finding this test guards: `readFile` would otherwise
   * buffer the whole file in the main process, and then push all of it
   * across IPC, before anything got a chance to say no. `stat` runs first and
   * the size check throws before `readFile` is ever reached — asserted here
   * by spying on the real `readFile`, not by faking one.
   *
   * It is a **rejection**, not a resolved `null`, and that is the property
   * the finding cares about most: a renderer that only checked "was it null"
   * would report a cancellation for a file the user genuinely chose.
   * `.rejects` only passes if the promise never resolves at all.
   */
  it('rejects a file over the byte cap without reading it into memory', async () => {
    const path = join(root, 'big.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, 'x'.repeat(MAX_THEME_BYTES + 1), 'utf8');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });

    await expect(pickTheme({ sender: {} } as never)).rejects.toThrow(
      new RegExp(`over the ${MAX_THEME_BYTES}-byte limit`),
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('still round-trips a file at exactly the byte cap', async () => {
    const path = join(root, 'exactly-at-cap.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, 'x'.repeat(MAX_THEME_BYTES), 'utf8');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });

    const result = await pickTheme({ sender: {} } as never);

    expect(result).toEqual({ path, contents: 'x'.repeat(MAX_THEME_BYTES) });
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

  it('rejects contents over the byte cap', () => {
    expect(() =>
      parseSaveThemeRequest({
        suggestedName: 'x.json',
        contents: 'x'.repeat(MAX_THEME_BYTES + 1),
      }),
    ).toThrow(/limit/);
  });

  /**
   * The cap is named in bytes and `String.length` counts UTF-16 code units.
   * Measured with `.length`, this payload passed and `writeFile(…, 'utf8')`
   * put roughly three times the cap on disk — a file `pickTheme` would then
   * refuse to read back, so Export could write what Import could not open.
   */
  it('measures the cap in bytes, not code units', () => {
    const underInUnits = '日'.repeat(MAX_THEME_BYTES - 1);
    expect(underInUnits.length).toBeLessThan(MAX_THEME_BYTES);

    expect(() =>
      parseSaveThemeRequest({ suggestedName: 'x.json', contents: underInUnits }),
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
