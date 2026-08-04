// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseCloneUrl } from '../../../../electron/main/clone/parse-url';

/**
 * The security boundary for argument injection (story 102).
 *
 * `git` is spawned with an argv array, so no quoting rule can turn a URL into a
 * command — but argv does nothing about a URL that *is* a flag, and both
 * `--upload-pack=…` and `ext::sh -c …` are remote code execution in a single
 * string. Those two cases are the reason this module exists; the rest is name
 * derivation.
 */
describe('parseCloneUrl', () => {
  it('accepts an https URL and derives the folder name', () => {
    expect(parseCloneUrl('https://github.com/behiques/the-hive.git')).toEqual({
      ok: true,
      url: 'https://github.com/behiques/the-hive.git',
      repoName: 'the-hive',
    });
  });

  it('accepts an scp-style ssh URL', () => {
    expect(parseCloneUrl('git@github.com:behiques/the-hive.git')).toMatchObject({
      ok: true,
      repoName: 'the-hive',
    });
  });

  it('accepts an ssh:// URL', () => {
    expect(
      parseCloneUrl('ssh://git@github.com/behiques/the-hive'),
    ).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('accepts a file:// URL, which the e2e fixture uses', () => {
    expect(parseCloneUrl('file:///tmp/fixture/the-hive.git')).toMatchObject({
      ok: true,
      repoName: 'the-hive',
    });
  });

  it('accepts an absolute local path', () => {
    expect(parseCloneUrl('/tmp/fixture/the-hive.git')).toMatchObject({
      ok: true,
      repoName: 'the-hive',
    });
  });

  it('strips a trailing slash before deriving the name', () => {
    expect(parseCloneUrl('https://github.com/behiques/the-hive/')).toMatchObject(
      { ok: true, repoName: 'the-hive' },
    );
  });

  it('trims surrounding whitespace from a pasted URL', () => {
    expect(
      parseCloneUrl('  https://github.com/behiques/the-hive.git  '),
    ).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('rejects a value starting with a dash, which git would read as a flag', () => {
    expect(parseCloneUrl('--upload-pack=touch /tmp/pwned')).toEqual({
      ok: false,
      reason: 'a repository URL cannot start with "-"',
    });
  });

  it('rejects the ext:: transport, which executes a shell command', () => {
    expect(parseCloneUrl('ext::sh -c "touch /tmp/pwned"')).toMatchObject({
      ok: false,
    });
  });

  it('rejects plaintext http with a message naming https', () => {
    expect(parseCloneUrl('http://github.com/behiques/the-hive.git')).toEqual({
      ok: false,
      reason: 'http:// is not encrypted — use https:// instead',
    });
  });

  it('rejects the git:// transport with a message naming https', () => {
    expect(parseCloneUrl('git://github.com/behiques/the-hive.git')).toEqual({
      ok: false,
      reason: 'git:// is not encrypted or authenticated — use https:// instead',
    });
  });

  it('rejects a URL with no derivable folder name', () => {
    expect(parseCloneUrl('https://github.com/')).toEqual({
      ok: false,
      reason: 'that URL does not name a repository',
    });
  });

  it('rejects a non-string', () => {
    expect(parseCloneUrl(42)).toMatchObject({ ok: false });
  });

  it('rejects an empty string', () => {
    expect(parseCloneUrl('   ')).toMatchObject({ ok: false });
  });

  it('rejects a control character', () => {
    expect(parseCloneUrl('https://example.com/a\nb.git')).toMatchObject({
      ok: false,
    });
  });

  it('rejects a name that would escape the parent directory', () => {
    expect(parseCloneUrl('https://example.com/a/..')).toMatchObject({
      ok: false,
    });
  });

  it('rejects a path segment that is only .git', () => {
    expect(parseCloneUrl('https://example.com/repos/.git')).toMatchObject({
      ok: false,
    });
  });
});
