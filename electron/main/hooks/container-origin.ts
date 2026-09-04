/**
 * The container substitution (HIVE-131).
 *
 * A containerised session cannot reach `http://127.0.0.1:<port>` — inside a
 * container that is the *container's* own loopback. Docker Desktop, OrbStack,
 * Rancher and podman all proxy the connection from the host side, so a
 * loopback-bound receiver is already reachable; what fails is only the *name*.
 * Measured against Docker Desktop 29.5.2 with the socket bound to `127.0.0.1`
 * alone: `container → host.docker.internal:<port>` answers 200, while the same
 * container's `127.0.0.1:<port>` is refused.
 *
 * The fix is therefore a hostname substitution and not a bind change, which is
 * why this file exists and `receiver.ts` is untouched by the story that added
 * it. Nothing here opens a socket, reads config, or knows a route.
 *
 * ## Why a string transform rather than `new URL()`
 *
 * `new URL('http://127.0.0.1:63999').toString()` is
 * `'http://127.0.0.1:63999/'` — a round-trip *adds* a path to a bare origin.
 * That value is what `hooks/index.ts:342` forwards as `HIVE_RECEIVER_URL`, and
 * `mcp-host/host.ts:52` builds request paths onto it from
 * `@shared/ledger-contract`, so the gained slash would yield `…//ledger` and a
 * 404 on every ledger call. Rewriting the authority in place preserves "no
 * path" exactly.
 */

/**
 * `scheme://`, authority, then everything else — path, query and fragment.
 *
 * Case-insensitive because `HTTP://…` is a legal URL: without the flag it fails
 * to match and `withHostAlias` silently returns the loopback address, which a
 * container cannot reach and which no error would announce.
 */
const AUTHORITY = /^(https?:\/\/)([^/?#]+)(.*)$/i;

/**
 * Rewrite `url` to address the host by `alias` instead.
 *
 * Operates on URLs this app produced (`http://127.0.0.1:<port><path?>`), so the
 * authority is a bare host with an optional port and never carries credentials
 * or an IPv6 literal in brackets — `parse.ts` rejects an alias containing `:`
 * for the same reason.
 *
 * A URL this does not recognise is returned unchanged rather than throwing: the
 * caller's alternative is a broken generated file, and the loopback value is
 * the strictly better failure.
 */
export function withHostAlias(url: string, alias: string): string {
  const parts = AUTHORITY.exec(url);
  if (parts === null) return url;

  const authority = parts[2];
  const colon = authority.lastIndexOf(':');
  const port = colon === -1 ? '' : authority.slice(colon);

  return `${parts[1]}${alias}${port}${parts[3]}`;
}
