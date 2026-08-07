// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  /**
   * HIVE-67. `ipc/index.ts` builds the Jira integration at registration time
   * and hands it `safeStorage`, so the mock has to answer for it. Encryption
   * reports as unavailable, which is the state that stores nothing — a test of
   * the config channels must not write a credential file.
   */
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

const { assertSender, isTrustedSender, IpcSenderError } = await import(
  '../../../electron/main/ipc/sender'
);
const { PRODUCTION_CSP, DEVELOPMENT_CSP, cspFor, isDevRenderer } = await import(
  '../../../electron/main/csp'
);

/** An event as Electron delivers it, with a swappable sending frame. */
const eventFrom = (senderFrame: unknown, mainFrame: unknown = senderFrame) =>
  ({ senderFrame, sender: { mainFrame } }) as never;

describe('assertSender', () => {
  it('accepts the main frame of the app’s own window', () => {
    const mainFrame = { url: 'file:///out/renderer/index.html' };
    expect(isTrustedSender(eventFrom(mainFrame))).toBe(true);
    expect(() => assertSender(eventFrom(mainFrame))).not.toThrow();
  });

  it('rejects a subframe — any frame in the process could otherwise invoke', () => {
    const mainFrame = { url: 'file:///out/renderer/index.html' };
    const iframe = { url: 'https://evil.example/' };

    expect(isTrustedSender(eventFrom(iframe, mainFrame))).toBe(false);
    expect(() => assertSender(eventFrom(iframe, mainFrame))).toThrow(IpcSenderError);
  });

  it('rejects a frame destroyed between send and handle', () => {
    // Nothing left to verify against, so it is not trusted.
    expect(isTrustedSender(eventFrom(null, {}))).toBe(false);
    expect(isTrustedSender(eventFrom(undefined, {}))).toBe(false);
  });
});

describe('content security policy', () => {
  it('closes every directive that can be closed, in production', () => {
    expect(PRODUCTION_CSP).toContain("default-src 'self'");
    expect(PRODUCTION_CSP).toContain("script-src 'self'");
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("frame-src 'none'");
  });

  it('never allows unsafe-eval and never a wildcard host', () => {
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval');
    expect(PRODUCTION_CSP).not.toMatch(/\*/);
  });

  it('does not allow inline script in production', () => {
    const scriptSrc = PRODUCTION_CSP.split('; ').find((d) =>
      d.startsWith('script-src'),
    );
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('keeps connect-src at self — the exfiltration path from terminal output', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'self'");
  });

  it('allows inline style, which xterm and Tailwind v4 both require', () => {
    expect(PRODUCTION_CSP).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('relaxes only for the dev server, and still bans unsafe-eval', () => {
    expect(DEVELOPMENT_CSP).toContain('ws:');
    expect(DEVELOPMENT_CSP).not.toContain('unsafe-eval');
    // A dev policy of "everything" trains you against rules the app lacks.
    expect(DEVELOPMENT_CSP).not.toContain("default-src *");
  });

  it('selects the strict policy unless electron-vite set a renderer URL', () => {
    expect(cspFor(false)).toBe(PRODUCTION_CSP);
    expect(cspFor(true)).toBe(DEVELOPMENT_CSP);

    expect(isDevRenderer({})).toBe(false);
    expect(isDevRenderer({ ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(
      true,
    );
  });
});
