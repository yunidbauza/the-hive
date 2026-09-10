import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_THEME_BYTES } from '@shared/theme-contract';

import {
  PICK_FAILURE_TITLE,
  PickThemeFailure,
  pickThemeFile,
  saveThemeFile,
  sanitizeFileName,
} from '@lib/theme/files';

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.restoreAllMocks();
});

/**
 * Captures the `<input type="file">` the picker builds for itself, so a test
 * can dispatch `change` on the real one rather than a stand-in.
 */
function captureInput(): { current: HTMLInputElement | undefined } {
  const box: { current: HTMLInputElement | undefined } = { current: undefined };
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = create(tag);
    if (tag === 'input') box.current = el as HTMLInputElement;
    return el;
  }) as typeof document.createElement);
  return box;
}

function choose(input: HTMLInputElement | undefined, file: unknown): void {
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  input?.dispatchEvent(new Event('change'));
}

describe('the bridge is never consulted', () => {
  /**
   * A theme file lives on the machine the user is sitting at, so there is no
   * mode in which asking main is right (HIVE-146). `window.hive` is always
   * defined in the packaged app, so "a bridge exists" was never the question
   * worth branching on — these two prove it is ignored when present.
   */
  it('reads the file in the renderer even when a bridge is present', async () => {
    const pick = vi.fn();
    (window as never as { hive: unknown }).hive = { theme: { pick } };
    const input = captureInput();

    const promise = pickThemeFile();
    choose(input.current, new File(['{"hiveThemeVersion":1}'], 'nord.json'));

    expect(await promise).toEqual({
      name: 'nord.json',
      contents: '{"hiveThemeVersion":1}',
    });
    expect(pick).not.toHaveBeenCalled();
  });

  it('downloads on save even when a bridge is present', async () => {
    const save = vi.fn();
    (window as never as { hive: unknown }).hive = { theme: { save } };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    expect(await saveThemeFile('nord.json', '{}')).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * `electron/main/theme/index.ts` used to `stat` before it read, so an
   * oversize file was refused without ever being buffered. `validate.ts` still
   * caps the contents, but only once the whole file is in renderer memory;
   * this keeps the cheaper refusal that deleting main's copy would have lost.
   */
  it('refuses an oversize file before reading it', async () => {
    const input = captureInput();
    const text = vi.fn(() => Promise.resolve('{}'));

    const promise = pickThemeFile();
    choose(input.current, {
      name: 'huge.json',
      size: MAX_THEME_BYTES + 1,
      text,
    });

    const failure = await promise.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PickThemeFailure);
    if (!(failure instanceof PickThemeFailure)) throw failure;
    expect(failure.detail).toBe(
      `huge.json is ${MAX_THEME_BYTES + 1} bytes, over the ${MAX_THEME_BYTES}-byte limit`,
    );
    expect(text).not.toHaveBeenCalled();
  });
});

describe('without a bridge (the browser target)', () => {
  it('falls back to a file input rather than doing nothing', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    void pickThemeFile();
    expect(click).toHaveBeenCalled();
  });

  it('resolves the chosen file\'s name and contents on change', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const promise = pickThemeFile();
    const file = new File(['{"hiveThemeVersion":1}'], 'midnight.json', {
      type: 'application/json',
    });
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    input?.dispatchEvent(new Event('change'));

    expect(await promise).toEqual({
      name: 'midnight.json',
      contents: '{"hiveThemeVersion":1}',
    });
  });

  it('resolves null when the picker is dismissed with nothing chosen', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const promise = pickThemeFile();
    input?.dispatchEvent(new Event('cancel'));

    expect(await promise).toBeNull();
  });

  it('resolves null when change fires with no file in the list', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const promise = pickThemeFile();
    Object.defineProperty(input!, 'files', { value: [], configurable: true });
    input?.dispatchEvent(new Event('change'));

    expect(await promise).toBeNull();
  });

  it('rejects rather than hanging if reading the chosen file fails', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const brokenFile = { name: 'broken.json', text: () => Promise.reject(new Error('nope')) };
    const promise = pickThemeFile();
    Object.defineProperty(input!, 'files', { value: [brokenFile], configurable: true });
    input?.dispatchEvent(new Event('change'));

    await expect(promise).rejects.toThrow('nope');
  });

  it('rejects with a structured PickThemeFailure here too, not a bare Error', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const brokenFile = { name: 'broken.json', text: () => Promise.reject(new Error('nope')) };
    const promise = pickThemeFile();
    Object.defineProperty(input!, 'files', { value: [brokenFile], configurable: true });
    input?.dispatchEvent(new Event('change'));

    try {
      await promise;
      expect.unreachable('pickThemeFile should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PickThemeFailure);
      if (!(error instanceof PickThemeFailure)) throw error;
      expect(error.title).toBe(PICK_FAILURE_TITLE);
      expect(error.detail).toBe('nope');
    }
  });

  /**
   * `cancel` is not universal, and the promise used to settle on nothing else.
   *
   * In an engine that never fires it, dismissing the dialog left this pending
   * forever — and `ThemeGallery` clears its `importing` flag in a `finally`,
   * so Import stayed disabled for the rest of the session with two listeners
   * and a live promise held behind it.
   */
  it('settles as a cancel when the window comes back with nothing chosen', async () => {
    vi.useFakeTimers();
    try {
      let input: HTMLInputElement | undefined;
      const create = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = create(tag);
        if (tag === 'input') input = el as HTMLInputElement;
        return el;
      }) as typeof document.createElement);

      const promise = pickThemeFile();
      Object.defineProperty(input!, 'files', { value: [], configurable: true });

      // No `cancel` at all — only focus returning to the app.
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(500);

      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a chosen file win the race against that fallback', async () => {
    vi.useFakeTimers();
    try {
      let input: HTMLInputElement | undefined;
      const create = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = create(tag);
        if (tag === 'input') input = el as HTMLInputElement;
        return el;
      }) as typeof document.createElement);

      const promise = pickThemeFile();
      const file = new File(['{}'], 'nord.json', { type: 'application/json' });
      Object.defineProperty(input!, 'files', { value: [file], configurable: true });

      // Focus returns first — the dialog closing is what gives it back — and
      // the `change` follows within the grace period.
      window.dispatchEvent(new Event('focus'));
      input?.dispatchEvent(new Event('change'));
      await vi.advanceTimersByTimeAsync(500);

      expect(await promise).toEqual({ name: 'nord.json', contents: '{}' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches its listeners once it has settled', async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    }) as typeof document.createElement);

    const text = vi.fn(() => Promise.resolve('{}'));
    const file = { name: 'nord.json', text };
    const promise = pickThemeFile();
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });

    input?.dispatchEvent(new Event('change'));
    await promise;

    // A second `change` must not reach a handler at all. A `settled` flag
    // alone would still have read the file a second time.
    input?.dispatchEvent(new Event('change'));
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('saves through a Blob download', async () => {
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:stub');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    expect(await saveThemeFile('hive-theme-template.json', '{}')).toBe(true);
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:stub');
  });

  it('revokes the object URL even if the click throws', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });

    await expect(saveThemeFile('theme.json', '{}')).rejects.toThrow('blocked');
    expect(revoke).toHaveBeenCalledWith('blob:stub');
  });

  it('sanitises the suggested name for the downloaded file too', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    await saveThemeFile('日本語.json', '{}');

    expect(downloadName).toBe('theme.json');
  });
});

describe('PickThemeFailure', () => {
  it('defaults its title to PICK_FAILURE_TITLE and carries detail separately', () => {
    const failure = new PickThemeFailure('the file is 300 KB, over the 256 KB limit.');
    expect(failure.title).toBe(PICK_FAILURE_TITLE);
    expect(failure.detail).toBe('the file is 300 KB, over the 256 KB limit.');
    expect(failure).toBeInstanceOf(Error);
  });

  it('accepts an explicit title, still keeping it out of detail', () => {
    const failure = new PickThemeFailure('nope', 'A different title');
    expect(failure.title).toBe('A different title');
    expect(failure.detail).toBe('nope');
  });
});

describe('sanitizeFileName', () => {
  it('passes an already-valid name through unchanged', () => {
    expect(sanitizeFileName('hive-theme-template.json')).toBe(
      'hive-theme-template.json',
    );
  });

  it('transliterates Latin diacritics', () => {
    expect(sanitizeFileName('Café.json')).toBe('Cafe.json');
  });

  it('falls back to a usable stem when nothing ASCII survives', () => {
    expect(sanitizeFileName('日本語.json')).toBe('theme.json');
    expect(sanitizeFileName('!!!.json')).toBe('theme.json');
  });

  it('replaces disallowed characters with a separator and collapses runs', () => {
    expect(sanitizeFileName('My Theme!!.json')).toBe('My-Theme.json');
  });

  it('appends .json when the input has no extension at all', () => {
    expect(sanitizeFileName('My Theme')).toBe('My-Theme.json');
  });

  it('always returns a name main\'s pattern accepts', () => {
    const inputs = [
      'Café.json',
      '日本語.json',
      'My Theme!!.json',
      'a'.repeat(200) + '.json',
      '....json',
      '',
      '🎨.json',
    ];
    for (const input of inputs) {
      expect(sanitizeFileName(input)).toMatch(/^[\w.-]{1,64}\.json$/);
    }
  });

  it('truncates a very long name to fit the 64-character cap', () => {
    const result = sanitizeFileName('a'.repeat(200) + '.json');
    expect(result).toMatch(/^[\w.-]{1,64}\.json$/);
    expect(result.length).toBeLessThanOrEqual(69);
  });
});
