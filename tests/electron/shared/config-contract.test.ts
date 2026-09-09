// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  BIND_KEYS,
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
  DEFAULT_REMOTE,
  RECEIVER_KEYS,
  REMOTE_KEYS,
  isLoopbackHost,
  isOrigin,
  isRemoteTarget,
  isTailnetHost,
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

describe('the remote block', () => {
  it('defaults to local mode with no address, so a never-attached install carries no target', () => {
    expect(DEFAULT_REMOTE).toEqual({ mode: 'local', host: '', port: 7433 });
  });

  it('names mode, host and port, for the parser exact-key check', () => {
    expect([...REMOTE_KEYS]).toEqual(['mode', 'host', 'port']);
  });
});

describe('isTailnetHost', () => {
  it('accepts the CGNAT range Tailscale hands out', () => {
    expect(isTailnetHost('100.64.0.0')).toBe(true);
    expect(isTailnetHost('100.100.100.100')).toBe(true);
    expect(isTailnetHost('100.127.255.255')).toBe(true);
  });

  it('refuses addresses just outside it', () => {
    // 100.64.0.0/10 is 100.64.x.x through 100.127.x.x.
    expect(isTailnetHost('100.63.255.255')).toBe(false);
    expect(isTailnetHost('100.128.0.0')).toBe(false);
    expect(isTailnetHost('101.64.0.1')).toBe(false);
  });

  it('accepts a .ts.net MagicDNS name', () => {
    expect(isTailnetHost('mini.tail1234.ts.net')).toBe(true);
  });

  it('refuses a public address and a bare hostname', () => {
    expect(isTailnetHost('203.0.113.7')).toBe(false);
    expect(isTailnetHost('mini.local')).toBe(false);
  });
});

/**
 * A dedicated spelling suite, the way `isNumericWildcard`'s earned one after
 * HIVE-142 — for the same reason: the brief's own snippet (three in-range,
 * three out, one `.ts.net`, two negatives, above) all still pass under the
 * most natural "make this readable" refactor of {@link TAILNET_V4} — split on
 * `.`, `Number` each part, range-check 0–255 — and that refactor is exactly
 * HIVE-142's octal bug again: `Number('064')` is `52`, not refused for having
 * a leading zero, so `0100.64.0.1` and `100.064.0.1` would both pass. Nothing
 * above would have caught it. See this file's mutation-proof notes in the
 * task report for the refactor applied and the tests that failed under it.
 *
 * Several of these assert `false` on a string that is not actually dangerous
 * — a trailing dot, trailing whitespace, a bare `ts.net` with no node name.
 * That is the safe direction (refuse when unsure) and is recorded here as
 * deliberate, not as an oversight to later "fix" into acceptance.
 */
describe('isTailnetHost — spelling attacks (review round 1)', () => {
  it('refuses a leading-zero octet, which some resolvers still read as octal', () => {
    expect(isTailnetHost('0100.64.0.1')).toBe(false);
    expect(isTailnetHost('100.064.0.1')).toBe(false);
    expect(isTailnetHost('0100.0100.0.1')).toBe(false);
  });

  it('refuses a hex-looking octet', () => {
    expect(isTailnetHost('0x64.64.0.1')).toBe(false);
  });

  /**
   * Important-1: without a bound on the third and fourth octets, this string
   * is not an IPv4 literal at all (`net.isIPv4` agrees) and gets handed to
   * the DNS resolver as a hostname instead — see `TAILNET_V4`'s own doc
   * comment for the full failure scenario.
   */
  it('refuses an octet past 255, so a typo cannot fall through to the resolver', () => {
    expect(isTailnetHost('100.64.0.257')).toBe(false);
  });

  it('refuses a bare 32-bit integer spelling of an address', () => {
    expect(isTailnetHost('1681997825')).toBe(false);
  });

  it('refuses an IPv4-mapped IPv6 literal', () => {
    expect(isTailnetHost('::ffff:100.64.0.1')).toBe(false);
  });

  /**
   * A trailing dot is a legitimate absolute-FQDN spelling of an IPv4 literal
   * in some resolvers, and trailing whitespace is a value nobody meant to
   * type. Refusing both is the safe direction — deliberate, not a gap.
   */
  it('refuses a trailing dot and trailing whitespace', () => {
    expect(isTailnetHost('100.64.0.1.')).toBe(false);
    expect(isTailnetHost('100.64.0.1 ')).toBe(false);
  });

  /**
   * Confirms the suffix check is `endsWith('.ts.net')`, not
   * `includes('ts.net')` — both strings below contain the substring
   * `ts.net` without the value actually being a name inside that domain.
   */
  it('refuses a string that merely contains ts.net without ending in it', () => {
    expect(isTailnetHost('notts.net')).toBe(false);
    expect(isTailnetHost('evil.ts.net.attacker.com')).toBe(false);
  });

  /** The bare suffix names no machine, so it is not a MagicDNS name. */
  it('refuses the bare suffix with no node name in front of it', () => {
    expect(isTailnetHost('ts.net')).toBe(false);
  });

  it('accepts the suffix regardless of case', () => {
    expect(isTailnetHost('x.TS.NET')).toBe(true);
  });
});

describe('isRemoteTarget', () => {
  it('accepts loopback, so a developer can attach to their own machine', () => {
    expect(isRemoteTarget('127.0.0.1')).toBe(true);
    expect(isRemoteTarget('localhost')).toBe(true);
  });

  it('accepts a tailnet address', () => {
    expect(isRemoteTarget('100.64.1.2')).toBe(true);
  });

  it('refuses anything else, because the socket is plaintext', () => {
    expect(isRemoteTarget('203.0.113.7')).toBe(false);
    expect(isRemoteTarget('0.0.0.0')).toBe(false);
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
