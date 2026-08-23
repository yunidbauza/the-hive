// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `session:history` says which records are still running (HIVE-88).
 *
 * Mocked the way `config-channels.test.ts` is, and for the same reason: the
 * handler is only callable by Electron, so `ipcMain.handle` is recorded. The
 * session layer is the real one with `entities()` replaced, because the fact
 * under test is the seam — that the handler consults the registry rather than
 * the ledger's own idea of which records are this run's — and the ledger is a
 * fake so the records are a literal rather than a file.
 */
const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

let liveIds: string[] = [];

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    getPath: () => '/tmp/hive-test',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('../../../../electron/main/pty-host', () => ({
  registerPtyHost: () => ({
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
    onSpawned: () => () => {},
    onError: () => () => {},
    onSessionLost: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({
  onShutdown: vi.fn(),
}));

const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
  projects: [],
  errors: [],
};

vi.mock('../../../../electron/main/config/index', () => ({
  getConfig: vi.fn(() => snapshot),
  reloadConfig: vi.fn(() => snapshot),
  loadConfig: vi.fn(() => snapshot),
  addProject: vi.fn(() => snapshot),
  removeProject: vi.fn(() => snapshot),
  renameProject: vi.fn(() => snapshot),
  repointProject: vi.fn(() => snapshot),
  reorderProjects: vi.fn(() => snapshot),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

const RECORDS = [
  { id: 'live-01', project: 'p', task: '', status: 'idle', createdAt: 1 },
  { id: 'old-01', project: 'p', task: '', status: 'working', createdAt: 2 },
];

vi.mock('../../../../electron/main/sessions/ledger', () => ({
  createSessionLedger: () => ({
    begin: vi.fn(),
    record: vi.fn(),
    resumable: () => undefined,
    all: () => RECORDS.map((record) => ({ ...record })),
    flush: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('../../../../electron/main/sessions/index', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../electron/main/sessions/index')>();
  return {
    ...actual,
    createSessions: (options: Parameters<typeof actual.createSessions>[0]) => ({
      ...actual.createSessions(options),
      entities: () => liveIds,
    }),
  };
});

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

const history = () =>
  Promise.resolve().then(
    () =>
      handlers.get(CH.sessionHistory)!(trustedEvent, undefined) as {
        id: string;
        live?: true;
      }[],
  );

beforeEach(() => {
  handlers.clear();
  liveIds = [];
  vi.clearAllMocks();
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('session:history (HIVE-88)', () => {
  it('marks the records the registry still runs, and only those', async () => {
    liveIds = ['live-01'];

    const answer = await history();

    expect(answer.find((record) => record.id === 'live-01')?.live).toBe(true);
    expect(answer.find((record) => record.id === 'old-01')).not.toHaveProperty('live');
  });

  it('marks nothing when nothing is running', async () => {
    // A fresh launch: every record is history, and the wire shape is exactly
    // the file's — an older renderer reading it sees nothing new.
    const answer = await history();

    expect(answer).toHaveLength(2);
    for (const record of answer) expect(record).not.toHaveProperty('live');
  });

  it('hands back copies, not the ledger records themselves', async () => {
    liveIds = ['live-01'];

    const answer = await history();
    const live = answer.find((record) => record.id === 'live-01')!;
    delete live.live;

    expect((await history()).find((record) => record.id === 'live-01')?.live).toBe(true);
  });
});
