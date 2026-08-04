/**
 * Validating a clone URL, and deriving the folder it becomes (story 102).
 *
 * Two jobs in one module because they are the same question asked twice: a URL
 * this rejects has no folder name, and a URL with no folder name is one we
 * cannot clone. Splitting them would let a caller take the name from a URL that
 * was never accepted.
 *
 * Pure, and deliberately the only place either rule lives. `git` is spawned with
 * an argv array so no quoting rule can turn a URL into a command — but argv does
 * nothing about a URL that *is* a flag, and `--upload-pack=…` and `ext::sh -c …`
 * are both remote code execution in a single string. That is what the leading-`-`
 * and transport checks below are for.
 */

export type CloneUrlVerdict =
  | { ok: true; url: string; repoName: string }
  | { ok: false; reason: string };

/**
 * Transports that carry no encryption or no authentication.
 *
 * Rejected with a message naming `https` rather than silently, because a user
 * pasting `git://` has a working URL in their hand and deserves to know why it
 * is refused.
 */
const REFUSED_SCHEMES: Record<string, string> = {
  'http:': 'http:// is not encrypted — use https:// instead',
  'git:': 'git:// is not encrypted or authenticated — use https:// instead',
};

/** Schemes we clone from. `file:` is also what the e2e suite uses. */
const ALLOWED_SCHEMES = new Set(['https:', 'ssh:', 'file:']);

/**
 * `user@host:path/to/repo.git` — git's scp-like syntax, which has no scheme.
 *
 * The negative lookahead after the colon is what keeps this from swallowing
 * `ssh://…`: a real scheme is followed by `//`, an scp-like path never is.
 */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/)/;

/**
 * Any C0 control character, or DEL.
 *
 * A loop rather than a character-class regex: expressing this as one trips
 * `no-control-regex`, and the house rule is that no lint rule may be disabled
 * inline to make code pass. Reading the code points directly says the same
 * thing and needs no exemption.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function fail(reason: string): CloneUrlVerdict {
  return { ok: false, reason };
}

/**
 * The last segment of a **path**, with `.git` and trailing slashes removed.
 *
 * Takes the path rather than the whole URL on purpose. Slicing at the last
 * separator of `https://github.com/` yields `github.com` — the *host* — which
 * would clone into a folder named after the forge. Every caller below passes
 * the path portion, so there is no host left to mistake for a repository.
 *
 * Returns `null` rather than a fallback name. A URL we cannot name a folder
 * from is a URL the user mistyped, and inventing `repo` for it would clone
 * something they did not ask for into a directory they did not expect.
 */
function deriveRepoName(path: string): string | null {
  const withoutQuery = path.split(/[?#]/)[0] ?? '';
  const trimmed = withoutQuery.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const segment = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  const name = segment.replace(/\.git$/i, '');

  if (name === '' || name === '.' || name === '..') return null;
  /**
   * A separator surviving into the folder name would let a URL choose where in
   * the filesystem the clone lands, which is the one thing main must decide.
   */
  if (name.includes('/') || name.includes('\\')) return null;
  return name;
}

/** Accept a value whose scheme has already been cleared, or say why not. */
function named(url: string, path: string, noun: string): CloneUrlVerdict {
  const repoName = deriveRepoName(path);
  return repoName === null
    ? fail(`that ${noun} does not name a repository`)
    : { ok: true, url, repoName };
}

export function parseCloneUrl(raw: unknown): CloneUrlVerdict {
  if (typeof raw !== 'string') return fail('expected a repository URL');

  const url = raw.trim();
  if (url === '') return fail('enter a repository URL');
  if (hasControlCharacter(url)) {
    return fail('that URL contains a control character');
  }

  /**
   * The check that closes argument injection.
   *
   * `git clone -- <url>` already stops a flag being read as one, and this module
   * is not the only guard. It is still refused here so the rejection has a
   * message, and so the rule survives anyone later changing how git is invoked.
   */
  if (url.startsWith('-')) return fail('a repository URL cannot start with "-"');

  // scp-like: everything after the first colon is the path on the remote host.
  if (SCP_LIKE.test(url)) {
    return named(url, url.slice(url.indexOf(':') + 1), 'URL');
  }

  // An absolute local path — a bare repo on this machine. No scheme to check.
  if (url.startsWith('/')) return named(url, url, 'path');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('that is not a repository URL');
  }

  const refusal = REFUSED_SCHEMES[parsed.protocol];
  if (refusal !== undefined) return fail(refusal);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return fail(
      `${parsed.protocol}// repositories are not supported — use https://`,
    );
  }

  return named(url, parsed.pathname, 'URL');
}
