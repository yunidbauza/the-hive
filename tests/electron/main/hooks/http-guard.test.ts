// @vitest-environment node
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

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

  it('is the same compare the receiver uses, not a second copy', async () => {
    const source = await readFile(
      new URL('../../../../electron/main/hooks/receiver.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('secretEquals(');
    expect(source).not.toMatch(/timingSafeEqual\s*\(/);
  });
});
