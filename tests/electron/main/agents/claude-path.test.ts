import { describe, expect, it } from 'vitest';

import { resolveClaude } from '../../../../electron/main/agents/claude-path';

/** Pretend exactly these paths are executable files. */
const executable = (...paths: string[]) => (p: string) => paths.includes(p);

describe('resolveClaude', () => {
  it('uses an absolute path as-is when it is executable', () => {
    expect(
      resolveClaude('/opt/bin/claude', undefined, executable('/opt/bin/claude')),
    ).toEqual({ path: '/opt/bin/claude' });
  });

  it('refuses an absolute path that is not executable', () => {
    const result = resolveClaude('/opt/bin/claude', undefined, executable());

    expect(result).toEqual({ problem: expect.stringContaining('/opt/bin/claude') });
  });

  it('scans PATH in order and takes the first hit', () => {
    expect(
      resolveClaude(
        'claude',
        '/a:/b:/c',
        executable('/b/claude', '/c/claude'),
      ),
    ).toEqual({ path: '/b/claude' });
  });

  /**
   * A space in an absolute path is not an argument. Refusing this one told the
   * user to "set Settings › Runtime to a plain path" — which is exactly what
   * they had done, on a perfectly ordinary macOS path.
   */
  it('accepts an absolute path containing a space when the file is really there', () => {
    const path = '/Users/me/Application Support/bin/claude';

    expect(resolveClaude(path, undefined, executable(path))).toEqual({ path });
  });

  it('still refuses an absolute-looking command with arguments, which no file backs', () => {
    const result = resolveClaude('/opt/bin/claude --tel', undefined, executable());

    expect(result).toEqual({ problem: expect.stringContaining('arguments') });
  });

  it('refuses a command carrying arguments rather than splitting it', () => {
    const result = resolveClaude('claude --tel', '/a', executable('/a/claude'));

    expect(result).toEqual({ problem: expect.stringContaining('arguments') });
  });

  it('refuses when PATH is unset', () => {
    const result = resolveClaude('claude', undefined, executable('/a/claude'));

    expect(result).toEqual({ problem: expect.stringContaining('PATH') });
  });

  it('refuses when nothing on PATH matches', () => {
    const result = resolveClaude('claude', '/a:/b', executable());

    expect(result).toEqual({ problem: expect.stringContaining('claude') });
  });
});
