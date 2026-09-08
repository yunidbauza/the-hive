import { describe, expect, it } from 'vitest';

import { parseInvocation } from '../../../electron/main/cli';

/** Packaged argv is [exe, ...args]; dev argv is [electron, appPath, ...args]. */
const packagedArgv = (...args: string[]) => ['/Applications/The Hive.app/x', ...args];
const devArgv = (...args: string[]) => ['/node_modules/electron', '/repo', ...args];

describe('parseInvocation', () => {
  it('is a plain app launch with no arguments', () => {
    expect(parseInvocation(packagedArgv(), true)).toEqual({ kind: 'app', server: false });
    expect(parseInvocation(devArgv(), false)).toEqual({ kind: 'app', server: false });
  });

  it('reads --server in both packaged and dev argv', () => {
    expect(parseInvocation(packagedArgv('--server'), true)).toEqual({ kind: 'app', server: true });
    expect(parseInvocation(devArgv('--server'), false)).toEqual({ kind: 'app', server: true });
  });

  it('does not mistake a path containing --server for the flag', () => {
    expect(parseInvocation(['/opt/--server/The Hive'], true)).toEqual({ kind: 'app', server: false });
  });

  it('reads --pair with a name', () => {
    expect(parseInvocation(packagedArgv('--pair', 'MacBook'), true)).toEqual({
      kind: 'pair',
      name: 'MacBook',
    });
  });

  it('reads a name with spaces', () => {
    expect(parseInvocation(packagedArgv('--pair', "Yunid's iPad"), true)).toEqual({
      kind: 'pair',
      name: "Yunid's iPad",
    });
  });

  it('asks for a name when --pair has none', () => {
    const result = parseInvocation(packagedArgv('--pair'), true);
    expect(result.kind).toBe('usage');
  });

  it('asks for a name when --revoke has none', () => {
    const result = parseInvocation(packagedArgv('--revoke'), true);
    expect(result.kind).toBe('usage');
  });

  it('asks for a name when the next token after --pair is another flag', () => {
    const result = parseInvocation(packagedArgv('--pair', '--devices'), true);
    expect(result.kind).toBe('usage');
  });

  it('asks for a name when the next token after --revoke is another flag', () => {
    const result = parseInvocation(packagedArgv('--revoke', '--server'), true);
    expect(result.kind).toBe('usage');
  });

  it('reads --revoke and --devices', () => {
    expect(parseInvocation(packagedArgv('--revoke', 'iPad'), true)).toEqual({
      kind: 'revoke',
      name: 'iPad',
    });
    expect(parseInvocation(packagedArgv('--devices'), true)).toEqual({ kind: 'devices' });
  });

  it('ignores Chromium switches the app is launched with', () => {
    expect(parseInvocation(packagedArgv('--user-data-dir=/tmp/x', '--server'), true)).toEqual({
      kind: 'app',
      server: true,
    });
  });

  it('prefers --pair over --devices when both are present, regardless of order', () => {
    expect(parseInvocation(packagedArgv('--devices', '--pair', 'MacBook'), true)).toEqual({
      kind: 'pair',
      name: 'MacBook',
    });
  });

  /**
   * HIVE-142 review, M1: the IPC path runs `assertText` (non-empty, capped,
   * no control characters) and the Settings pane trims — this argv path had
   * neither, so `--pair "   "` minted and persisted a device whose name
   * `optionalDevices` (`config/parse.ts`) then drops on every later load,
   * leaving a token that could never authenticate anything.
   */
  it('asks for a name when --pair is given only whitespace', () => {
    const result = parseInvocation(packagedArgv('--pair', '   '), true);
    expect(result.kind).toBe('usage');
  });

  it('asks for a name when --revoke is given only whitespace', () => {
    const result = parseInvocation(packagedArgv('--revoke', '   '), true);
    expect(result.kind).toBe('usage');
  });

  it('trims incidental whitespace around an otherwise valid --pair name', () => {
    expect(parseInvocation(packagedArgv('--pair', '  MacBook  '), true)).toEqual({
      kind: 'pair',
      name: 'MacBook',
    });
  });

  it('asks for a name when --pair carries a control character', () => {
    const result = parseInvocation(packagedArgv('--pair', 'Mac\nBook'), true);
    expect(result.kind).toBe('usage');
  });
});
