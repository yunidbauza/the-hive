import { afterEach, describe, expect, it, vi } from 'vitest';

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
 * What the renderer actually receives, verbatim.
 *
 * `ipcRenderer.invoke` does not forward main's error — it constructs a new one
 * quoting the channel and then the original, class name included. The strip
 * used to be anchored (`/^theme:pick:/`) and so never matched a single real
 * rejection: the banner showed both wrappers *and* an absolute path.
 */
const ELECTRON_OVERSIZE_ERROR =
  "Error invoking remote method 'theme:pick': IpcValidationError: theme:pick: /Users/me/themes/huge.json is 999999 bytes, over the 262144-byte limit";

describe('with the desktop bridge', () => {
  it('uses the native dialog and returns the file name, not the path', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: {
        pick: vi.fn().mockResolvedValue({
          path: '/Users/me/themes/nord.json',
          contents: '{}',
        }),
      },
    };

    expect(await pickThemeFile()).toEqual({ name: 'nord.json', contents: '{}' });
  });

  it('resolves null when the dialog is cancelled', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: { pick: vi.fn().mockResolvedValue(null) },
    };
    expect(await pickThemeFile()).toBeNull();
  });

  it('rejects, not resolving null, when main refuses an oversize file', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: { pick: vi.fn().mockRejectedValue(new Error(ELECTRON_OVERSIZE_ERROR)) },
    };

    // Not null: cancelling and being refused are different facts, and
    // collapsing them would report "cancelled" for a file the user really
    // did choose.
    await expect(pickThemeFile()).rejects.toThrow();
  });

  it('cleans the rejection message for display — no channel name, no path noise', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: { pick: vi.fn().mockRejectedValue(new Error(ELECTRON_OVERSIZE_ERROR)) },
    };

    /**
     * Asserted on `.detail` in full, not with `not.toThrow(/^theme:pick:/)`.
     *
     * That guard could never fail: `PickThemeFailure.message` is
     * `` `${title} — ${detail}` ``, so it always starts with the title and
     * never with the channel name, whatever the strip did or did not remove.
     * The exact string is what actually catches a regression — either wrapper
     * surviving, or the directory coming back.
     */
    const failure = await pickThemeFile().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PickThemeFailure);
    if (!(failure instanceof PickThemeFailure)) return;
    expect(failure.detail).toBe(
      'huge.json is 999999 bytes, over the 262144-byte limit',
    );
  });

  it('still surfaces a rejection that carries no useful message', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: { pick: vi.fn().mockRejectedValue('boom') },
    };

    await expect(pickThemeFile()).rejects.toThrow("Couldn't import that file");
  });

  /**
   * The seam a caller (Task 11's gallery) actually relies on: `.title` and
   * `.detail` come back as their own fields, not just baked into `.message`
   * — so a banner can render each once, rather than re-deriving a title and
   * duplicating what `.message` already prefixed onto the detail.
   */
  it('rejects with a PickThemeFailure carrying title and detail as their own fields', async () => {
    (window as never as { hive: unknown }).hive = {
      theme: { pick: vi.fn().mockRejectedValue(new Error(ELECTRON_OVERSIZE_ERROR)) },
    };

    await expect(pickThemeFile()).rejects.toBeInstanceOf(PickThemeFailure);
    try {
      await pickThemeFile();
      expect.unreachable('pickThemeFile should have rejected');
    } catch (error) {
      if (!(error instanceof PickThemeFailure)) throw error;
      expect(error.title).toBe(PICK_FAILURE_TITLE);
      /**
       * The file's *name* survives and its directory does not — a deliberate
       * choice, not an accident of the pattern. `huge.json is 999999 bytes` is
       * the whole of what the message has to say; `/Users/somebody/…` is a home
       * directory in a settings banner and in every screenshot of one.
       */
      expect(error.detail).toBe(
        'huge.json is 999999 bytes, over the 262144-byte limit',
      );
    }
  });

  it('strips main’s prefix even without the Electron wrapper around it', async () => {
    // The shape a direct caller (or a future non-`invoke` bridge) would send.
    (window as never as { hive: unknown }).hive = {
      theme: {
        pick: vi
          .fn()
          .mockRejectedValue(new Error('theme:pick: /tmp/huge.json is too big')),
      },
    };

    const failure = await pickThemeFile().catch((error: unknown) => error);
    if (!(failure instanceof PickThemeFailure)) throw failure;
    expect(failure.detail).toBe('huge.json is too big');
  });

  it('saves through the bridge and reports true when a path came back', async () => {
    const save = vi.fn().mockResolvedValue('/Users/me/themes/nord.json');
    (window as never as { hive: unknown }).hive = { theme: { save } };

    expect(await saveThemeFile('nord.json', '{}')).toBe(true);
    expect(save).toHaveBeenCalledWith({ suggestedName: 'nord.json', contents: '{}' });
  });

  it('reports false when the save dialog is cancelled', async () => {
    const save = vi.fn().mockResolvedValue(null);
    (window as never as { hive: unknown }).hive = { theme: { save } };

    expect(await saveThemeFile('nord.json', '{}')).toBe(false);
  });

  it('sanitises the suggested name before it ever reaches the bridge', async () => {
    const save = vi.fn().mockResolvedValue('/Users/me/themes/cafe.json');
    (window as never as { hive: unknown }).hive = { theme: { save } };

    await saveThemeFile('Café.json', '{}');

    expect(save).toHaveBeenCalledWith({ suggestedName: 'Cafe.json', contents: '{}' });
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
