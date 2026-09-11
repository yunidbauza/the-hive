// @vitest-environment node
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createOriginGuard, secretEquals } from '../../../../electron/main/hooks/http-guard';

const guard = (over: Partial<Parameters<typeof createOriginGuard>[0]> = {}) =>
  createOriginGuard({
    allowedOrigins: [],
    host: '127.0.0.1',
    hostAliases: () => new Set(['host.docker.internal']),
    ...over,
  });

describe('createOriginGuard', () => {
  it('admits a request with no Origin and a loopback Host', () => {
    expect(guard()({ host: '127.0.0.1:63999' })).toBeNull();
  });

  it('refuses any Origin when the allow-list is empty', () => {
    expect(guard()({ host: '127.0.0.1', origin: 'http://evil.test' })).toBe(403);
  });

  it('admits a listed Origin', () => {
    const g = guard({ allowedOrigins: ['http://localhost:5173'] });
    expect(g({ host: '127.0.0.1', origin: 'http://localhost:5173' })).toBeNull();
  });

  it('refuses a missing Host', () => {
    expect(guard()({})).toBe(403);
  });

  it('admits the configured host and every alias, and refuses others', () => {
    const g = guard({ host: '192.168.1.20', hostAliases: () => new Set(['a.test', 'b.test']) });
    expect(g({ host: '192.168.1.20:7000' })).toBeNull();
    expect(g({ host: 'a.test:7000' })).toBeNull();
    expect(g({ host: 'b.test' })).toBeNull();
    expect(g({ host: 'elsewhere.test' })).toBe(403);
  });

  it('keeps an IPv6 literal bracketed and reads it as loopback', () => {
    expect(guard()({ host: '[::1]:63999' })).toBeNull();
  });

  describe('onHostRefused (HIVE-142 review, I4)', () => {
    it('is called with the claimed Host and what would have been admitted, only on a Host refusal', () => {
      const onHostRefused = vi.fn();
      const g = guard({
        host: '100.64.1.2',
        hostAliases: () => new Set(['a.test']),
        onHostRefused,
      });

      expect(g({ host: 'my-tailscale-name:7433' })).toBe(403);

      expect(onHostRefused).toHaveBeenCalledTimes(1);
      expect(onHostRefused).toHaveBeenCalledWith('my-tailscale-name', ['100.64.1.2', 'a.test']);
    });

    it('is not called when the Host matches', () => {
      const onHostRefused = vi.fn();
      const g = guard({ host: '100.64.1.2', onHostRefused });

      expect(g({ host: '100.64.1.2:7433' })).toBeNull();

      expect(onHostRefused).not.toHaveBeenCalled();
    });

    it('is not called for an Origin refusal', () => {
      const onHostRefused = vi.fn();
      const g = guard({ onHostRefused });

      expect(g({ host: '127.0.0.1', origin: 'http://evil.test' })).toBe(403);

      expect(onHostRefused).not.toHaveBeenCalled();
    });

    it('never reaches the wire — the guard still only ever returns 403 or null', () => {
      const g = guard({ host: '100.64.1.2', onHostRefused: () => undefined });
      expect(g({ host: 'elsewhere.test' })).toBe(403);
    });
  });
});

describe('secretEquals', () => {
  it('is true for identical strings', () => {
    expect(secretEquals('abc123', 'abc123')).toBe(true);
  });

  it('is false for different strings of equal length', () => {
    expect(secretEquals('abc123', 'abc124')).toBe(false);
  });

  it('is false for different lengths, without throwing', () => {
    expect(secretEquals('short', 'muchlongervalue')).toBe(false);
  });

  it('is false for an empty offered value', () => {
    expect(secretEquals('', 'expected')).toBe(false);
  });

  /*
    Every caller, not only the receiver (HIVE-140 audit): HIVE-142's promise was
    one timing-safe compare and one Origin/Host guard, reused by the server
    rather than rewritten. A second copy in either server file would pass every
    behavioural test and quietly split the two apart.
  */
  it.each(['hooks/receiver.ts', 'server/devices.ts'])(
    'is the same compare %s uses, not a second copy',
    async (file) => {
      const source = await readFile(
        new URL(`../../../../electron/main/${file}`, import.meta.url),
        'utf8',
      );
      expect(source).toContain('secretEquals(');
      expect(source).not.toMatch(/timingSafeEqual\s*\(/);
    },
  );

  it('is the same Origin and Host guard the server listener uses, not a second copy', async () => {
    const source = await readFile(
      new URL('../../../../electron/remote-host/listener.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/import \{[^}]*\bcreateOriginGuard\b[^}]*\} from '[^']*http-guard'/);
    expect(source).toContain('createOriginGuard(');
    // No second read of either header, by bracket or by dot.
    expect(source).not.toMatch(/headers(\.|\[['"])(origin|host)\b/);
  });
});
