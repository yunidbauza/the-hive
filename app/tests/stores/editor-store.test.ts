import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileKey, useEditorStore } from '@stores/editor-store';

/**
 * Open file buffers.
 *
 * The store is a plain function and is the highest-value target in this
 * feature after the containment guard: the freshness matrix and the conflict
 * flow are both here, and both are the kind of logic that is much easier to get
 * wrong than to notice.
 */

const { readFile, writeFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
  writeFile,
}));

const store = () => useEditorStore.getState();
const fileAt = (key: string) => store().openFiles.find((file) => file.key === key);

const KEY = fileKey('demo', 'src/app.ts');

/** A successful read of `text` at `mtimeMs`. */
const content = (text: string, mtimeMs = 100) => ({
  ok: true as const,
  value: { text, mtimeMs, size: text.length },
});

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.getState().reset();
  readFile.mockResolvedValue(content('export {};\n'));
  writeFile.mockResolvedValue({ ok: true, mtimeMs: 200 });
});

afterEach(() => {
  useEditorStore.getState().reset();
});

describe('openFile', () => {
  it('adds a loading entry immediately and activates it', () => {
    store().openFile('demo', 'src/app.ts');

    expect(store().activeKey).toBe(KEY);
    expect(fileAt(KEY)).toMatchObject({
      relPath: 'src/app.ts',
      name: 'app.ts',
      loading: true,
      text: null,
    });
  });

  it('fills the buffer once the read resolves', async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));

    expect(fileAt(KEY)).toMatchObject({
      text: 'export {};\n',
      mtimeMs: 100,
      size: 11,
      dirty: false,
    });
  });

  /**
   * Re-opening never re-reads. The watcher keeps buffers current, so a second
   * click on an open tab would throw away the scroll position to fetch bytes
   * the store already has — and, if the buffer were dirty, the user's edits.
   */
  it('focuses an already-open file rather than re-reading it', async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
    store().edit(KEY, 'mine');
    store().showTerminal();

    store().openFile('demo', 'src/app.ts');

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(store().activeKey).toBe(KEY);
    expect(fileAt(KEY)?.text).toBe('mine');
  });

  it('records a refusal with its size', async () => {
    readFile.mockResolvedValue({
      ok: true,
      value: { refused: 'binary', size: 4096 },
    });

    store().openFile('demo', 'logo.png');
    const key = fileKey('demo', 'logo.png');
    await vi.waitFor(() => expect(fileAt(key)?.loading).toBe(false));

    expect(fileAt(key)).toMatchObject({ refusal: 'binary', size: 4096, text: null });
  });

  it('records a failure, and marks a missing file as missing', async () => {
    readFile.mockResolvedValue({
      ok: false,
      error: { code: 'ENOENT', message: 'cannot read that path' },
    });

    store().openFile('demo', 'gone.ts');
    const key = fileKey('demo', 'gone.ts');
    await vi.waitFor(() => expect(fileAt(key)?.loading).toBe(false));

    expect(fileAt(key)).toMatchObject({
      error: 'cannot read that path',
      missing: true,
    });
  });

  /**
   * A read that resolves after its tab was closed is the ordinary case — the
   * user clicked twice — and it must not resurrect the entry.
   */
  it('drops a read that resolves after the file was closed', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    readFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    store().openFile('demo', 'src/app.ts');
    store().closeFile(KEY);
    resolveRead(content('late'));

    await Promise.resolve();
    expect(store().openFiles).toHaveLength(0);
  });
});

describe('closeFile', () => {
  beforeEach(async () => {
    store().openFile('demo', 'a.ts');
    store().openFile('demo', 'b.ts');
    store().openFile('demo', 'c.ts');
    await vi.waitFor(() => expect(store().openFiles.every((f) => !f.loading)).toBe(true));
  });

  /**
   * Closing the active tab lands on its neighbour, not on the terminal: the
   * user was working in this region and closing one file is not a request to
   * leave it.
   */
  it('activates the tab to the right', () => {
    store().setActive(fileKey('demo', 'b.ts'));
    store().closeFile(fileKey('demo', 'b.ts'));

    expect(store().activeKey).toBe(fileKey('demo', 'c.ts'));
  });

  it('falls back to the tab on the left when closing the last one', () => {
    store().setActive(fileKey('demo', 'c.ts'));
    store().closeFile(fileKey('demo', 'c.ts'));

    expect(store().activeKey).toBe(fileKey('demo', 'b.ts'));
  });

  it('returns to the terminal when the last file closes', () => {
    store().closeAll();
    expect(store().activeKey).toBeNull();
    expect(store().openFiles).toHaveLength(0);
  });

  it('leaves the active tab alone when closing another', () => {
    store().setActive(fileKey('demo', 'a.ts'));
    store().closeFile(fileKey('demo', 'c.ts'));

    expect(store().activeKey).toBe(fileKey('demo', 'a.ts'));
    expect(store().openFiles).toHaveLength(2);
  });

  it('ignores an unknown key', () => {
    store().closeFile('nope');
    expect(store().openFiles).toHaveLength(3);
  });
});

describe('edit', () => {
  beforeEach(async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
  });

  it('marks the buffer dirty', () => {
    store().edit(KEY, 'changed');
    expect(fileAt(KEY)).toMatchObject({ text: 'changed', dirty: true });
  });

  /**
   * CodeMirror fires an update for a great many things that are not edits — a
   * selection change, a reconfiguration — and treating any of them as a
   * modification would put a dirty dot on a file nobody typed into.
   */
  it('ignores an update that did not change the text', () => {
    store().edit(KEY, 'export {};\n');
    expect(fileAt(KEY)?.dirty).toBe(false);
  });

  it('ignores an unknown key', () => {
    expect(() => store().edit('nope', 'x')).not.toThrow();
  });
});

describe('save', () => {
  beforeEach(async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
    store().edit(KEY, 'mine\n');
  });

  it('writes with the buffer’s base mtime and clears dirty', async () => {
    await store().save(KEY);

    expect(writeFile).toHaveBeenCalledWith('demo', 'src/app.ts', 'mine\n', 100);
    expect(fileAt(KEY)).toMatchObject({
      dirty: false,
      mtimeMs: 200,
      saving: false,
      conflict: false,
    });
  });

  it('flags a conflict and keeps the buffer dirty', async () => {
    writeFile.mockResolvedValue({ ok: false, conflict: true, mtimeMs: 500 });

    await store().save(KEY);

    expect(fileAt(KEY)).toMatchObject({ conflict: true, dirty: true });
    // The base is unchanged — a plain retry must fail the same way.
    expect(fileAt(KEY)?.mtimeMs).toBe(100);
  });

  /**
   * Overwrite re-reads the current mtime and writes against *that*. Without the
   * re-read the second attempt would carry the same stale base, be refused
   * again, and the button would look broken.
   */
  it('overwrite re-reads the mtime first, so the second attempt can succeed', async () => {
    writeFile.mockResolvedValueOnce({ ok: false, conflict: true, mtimeMs: 500 });
    await store().save(KEY);

    readFile.mockResolvedValue(content('theirs\n', 500));
    writeFile.mockResolvedValue({ ok: true, mtimeMs: 600 });

    await store().save(KEY, { overwrite: true });

    expect(writeFile).toHaveBeenLastCalledWith('demo', 'src/app.ts', 'mine\n', 500);
    expect(fileAt(KEY)).toMatchObject({ dirty: false, conflict: false, mtimeMs: 600 });
  });

  it('records a write failure without losing the buffer', async () => {
    writeFile.mockResolvedValue({
      ok: false,
      error: { code: 'EACCES', message: 'the filesystem refused that operation' },
    });

    await store().save(KEY);

    expect(fileAt(KEY)).toMatchObject({
      error: 'the filesystem refused that operation',
      dirty: true,
      text: 'mine\n',
    });
  });

  it('does nothing for an unknown key or an unread buffer', async () => {
    await store().save('nope');
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('reload', () => {
  it('replaces the buffer and clears the dirty and stale flags', async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
    store().edit(KEY, 'mine\n');

    readFile.mockResolvedValue(content('theirs\n', 900));
    await store().reload(KEY);

    expect(fileAt(KEY)).toMatchObject({
      text: 'theirs\n',
      mtimeMs: 900,
      dirty: false,
      staleOnDisk: false,
      conflict: false,
    });
  });

  it('ignores an unknown key', async () => {
    await expect(store().reload('nope')).resolves.toBeUndefined();
  });
});

/**
 * The freshness matrix — the point of the whole feature.
 *
 * | Buffer | Behaviour |
 * | --- | --- |
 * | clean | silently reloaded |
 * | dirty | marked stale, banner offers the choice |
 */
describe('reconcile', () => {
  beforeEach(async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
  });

  it('silently reloads a clean buffer', async () => {
    readFile.mockResolvedValue(content('agent wrote this\n', 700));

    store().reconcile('demo', ['src/app.ts']);
    await vi.waitFor(() => expect(fileAt(KEY)?.text).toBe('agent wrote this\n'));

    expect(fileAt(KEY)).toMatchObject({ staleOnDisk: false, dirty: false });
  });

  it('marks a dirty buffer stale instead of reloading it', async () => {
    store().edit(KEY, 'mine\n');
    readFile.mockResolvedValue(content('theirs\n', 700));

    store().reconcile('demo', ['src/app.ts']);
    await Promise.resolve();

    expect(fileAt(KEY)).toMatchObject({ staleOnDisk: true, text: 'mine\n' });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('ignores paths that name no open file', async () => {
    store().reconcile('demo', ['other.ts']);
    await Promise.resolve();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('ignores another project’s events', async () => {
    store().reconcile('elsewhere', ['src/app.ts']);
    await Promise.resolve();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  /**
   * A save writes the file, which the watcher then reports. Without this every
   * save would race its own change event and reload the file out from under
   * the cursor.
   */
  it('skips a buffer that is mid-save', async () => {
    let resolveWrite: (value: unknown) => void = () => {};
    writeFile.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );

    store().edit(KEY, 'mine\n');
    const saving = store().save(KEY);

    store().reconcile('demo', ['src/app.ts']);
    await Promise.resolve();
    expect(readFile).toHaveBeenCalledTimes(1);

    resolveWrite({ ok: true, mtimeMs: 300 });
    await saving;
  });
});

describe('showTerminal and setActive', () => {
  it('shows the terminal without closing anything', async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));

    store().showTerminal();

    expect(store().activeKey).toBeNull();
    expect(store().openFiles).toHaveLength(1);
  });

  it('switches back to a file', () => {
    store().openFile('demo', 'src/app.ts');
    store().showTerminal();
    store().setActive(KEY);

    expect(store().activeKey).toBe(KEY);
  });
});

/**
 * The two ways a save could quietly lose the user's work. Both were found in
 * review, and neither is reachable without a race — which is exactly why they
 * are pinned here rather than left to a manual test.
 */
describe('save — races', () => {
  beforeEach(async () => {
    store().openFile('demo', 'src/app.ts');
    await vi.waitFor(() => expect(fileAt(KEY)?.loading).toBe(false));
  });

  /**
   * A save is a round trip; the user can type during it. Clearing `dirty` on
   * success regardless would claim the disk holds text it does not — and the
   * watcher's echo would then find a "clean" buffer and reload over those
   * keystrokes.
   */
  it('stays dirty when the buffer changed while the write was in flight', async () => {
    let finishWrite: (value: unknown) => void = () => {};
    writeFile.mockReturnValue(
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );

    store().edit(KEY, 'first\n');
    const saving = store().save(KEY);

    // The user keeps typing before the write resolves.
    store().edit(KEY, 'first and second\n');

    finishWrite({ ok: true, mtimeMs: 400 });
    await saving;

    expect(writeFile).toHaveBeenCalledWith('demo', 'src/app.ts', 'first\n', 100);
    expect(fileAt(KEY)).toMatchObject({
      dirty: true,
      text: 'first and second\n',
    });
  });

  it('goes clean when nothing was typed during the write', async () => {
    store().edit(KEY, 'mine\n');
    await store().save(KEY);

    expect(fileAt(KEY)).toMatchObject({ dirty: false, text: 'mine\n' });
  });

  /**
   * The watcher is a *trailing* debounce, so a save's own echo always arrives
   * after `saving` has gone false — the flag structurally cannot suppress it.
   * Without the mtime record, every save would put a "changed on disk" banner
   * in front of the user for a write only they made.
   */
  it('does not report its own write back as somebody else’s change', async () => {
    store().edit(KEY, 'mine\n');
    await store().save(KEY);

    // Still typing, so the buffer is dirty when the echo lands.
    store().edit(KEY, 'mine, extended\n');
    store().reconcile('demo', ['src/app.ts']);
    await Promise.resolve();

    expect(fileAt(KEY)?.staleOnDisk).toBe(false);
  });

  it('reports the next change after the echo has been consumed', async () => {
    store().edit(KEY, 'mine\n');
    await store().save(KEY);

    store().reconcile('demo', ['src/app.ts']); // the echo
    await Promise.resolve();

    store().edit(KEY, 'mine again\n');
    store().reconcile('demo', ['src/app.ts']); // an agent, genuinely
    await Promise.resolve();

    expect(fileAt(KEY)?.staleOnDisk).toBe(true);
  });

  it('does not swallow an echo after a reload has replaced the buffer', async () => {
    store().edit(KEY, 'mine\n');
    await store().save(KEY);

    readFile.mockResolvedValue(content('theirs\n', 900));
    await store().reload(KEY);

    store().edit(KEY, 'mine again\n');
    store().reconcile('demo', ['src/app.ts']);
    await Promise.resolve();

    expect(fileAt(KEY)?.staleOnDisk).toBe(true);
  });
});

describe('fileKey', () => {
  it('is unique across projects', () => {
    expect(fileKey('a', 'src/x.ts')).not.toBe(fileKey('b', 'src/x.ts'));
  });
});
