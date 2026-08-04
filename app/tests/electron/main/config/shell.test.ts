// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { defaultShell } from '../../../../electron/main/config/shell';

const info = (shell: string | null) => () => ({ shell });

describe('defaultShell', () => {
  it('uses an absolute shell from the password database', () => {
    expect(defaultShell(info('/bin/zsh'), 'darwin')).toBe('/bin/zsh');
    expect(defaultShell(info('/usr/local/bin/fish'), 'linux')).toBe(
      '/usr/local/bin/fish',
    );
  });

  it('falls back to /bin/zsh on darwin when the entry is unusable', () => {
    expect(defaultShell(info(null), 'darwin')).toBe('/bin/zsh');
    expect(defaultShell(info(''), 'darwin')).toBe('/bin/zsh');
    // Relative paths cannot be spawned; they must not reach pty.spawn.
    expect(defaultShell(info('zsh'), 'darwin')).toBe('/bin/zsh');
  });

  it('falls back to /bin/sh off darwin', () => {
    expect(defaultShell(info(null), 'linux')).toBe('/bin/sh');
    expect(defaultShell(info('bash'), 'linux')).toBe('/bin/sh');
  });

  it('survives a userInfo that throws', () => {
    const throws = () => {
      throw new Error('getpwuid failed');
    };
    expect(defaultShell(throws, 'darwin')).toBe('/bin/zsh');
  });
});
