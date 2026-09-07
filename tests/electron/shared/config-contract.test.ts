// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  BIND_KEYS,
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
  RECEIVER_KEYS,
  isLoopbackHost,
  isOrigin,
} from '../../../electron/shared/config-contract';

describe('the receiver bind block', () => {
  it('defaults to the behaviour that shipped before it existed', () => {
    expect(DEFAULT_BIND).toEqual({ host: '127.0.0.1', port: 0, allowedOrigins: [] });
    expect(DEFAULT_RECEIVER.bind).toEqual(DEFAULT_BIND);
  });

  it('names bind as a receiver key, so the reader stops calling it unknown', () => {
    expect([...RECEIVER_KEYS]).toEqual(['hostAlias', 'bind']);
    expect([...BIND_KEYS]).toEqual(['host', 'port', 'allowedOrigins']);
  });
});

describe('isLoopbackHost', () => {
  it('accepts every spelling of this machine', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  /* The whole 127.0.0.0/8 block is loopback, so a bind inside it is not exposure. */
  it('accepts the far end of 127.0.0.0/8', () => {
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('refuses an address something else can reach', () => {
    for (const host of ['0.0.0.0', '172.17.0.1', '192.168.4.125', 'host.docker.internal', '128.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('isOrigin', () => {
  it('accepts a scheme, a host and an optional port', () => {
    for (const value of ['http://localhost:5173', 'https://example.test', 'http://127.0.0.1:8080']) {
      expect(isOrigin(value)).toBe(true);
    }
  });

  /*
    The delimiters `isHostAlias` exists to refuse, in the one place a scheme is
    legitimate. Each of these either terminates the authority or carries
    something an origin never carries.
  */
  it('refuses anything past the authority', () => {
    for (const value of [
      'http://localhost:5173/',
      'http://localhost:5173/path',
      'http://localhost:5173?q=1',
      'http://localhost:5173#f',
      'http://user:pw@localhost:5173',
      'localhost:5173',
      'ftp://localhost',
      'file:///etc/passwd',
      'http://localhost:80',
      ' http://localhost:5173',
      '',
      'null',
      42,
      null,
    ]) {
      expect(isOrigin(value)).toBe(false);
    }
  });
});
