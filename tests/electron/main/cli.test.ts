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
});
