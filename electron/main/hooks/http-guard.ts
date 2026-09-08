import { timingSafeEqual } from 'node:crypto';

import { isLoopbackHost } from '@shared/config-contract';

/**
 * HIVE-134's Origin and Host allow-list, and the timing-safe compare beside it.
 *
 * Extracted from `createReceiver` in HIVE-142, unchanged. Both were closures,
 * so `remote-host` could not reuse them and would have grown a second copy —
 * which is exactly what `eslint.config.mjs`'s remote-host zone comment says must
 * not happen. Parameterised rather than moved: `guard` closed over three values
 * that differ between the receiver and the server listener.
 *
 * Where the request claims it was going, checked before who it claims to be.
 *
 * ## Why this is not conditioned on the bind
 *
 * The obvious shape is to run this only when `receiver.bind` is widened, since
 * that is the exposure it answers. That shape was rejected: this app ships
 * macOS only, where no user sets that config, so the guard would be code that
 * never runs on the platform that ships — correct in a test and inert in the
 * world. It also answers something real at the loopback bind. DNS rebinding
 * points a hostile page's own hostname at `127.0.0.1`, and the browser then
 * treats this socket as same-origin and will read the responses. The token
 * still stops the page doing anything, so this is depth rather than a hole
 * being closed — but Origin and Host are the standard, one-line-each defence,
 * and there is no argument for owning the socket and skipping them.
 *
 * ## Why in `reject`, and before identity
 *
 * `reject` is the one function every handler already calls, which is what
 * makes "every route" true by construction rather than by eight people
 * remembering. Running before the token and session checks means a hostile
 * page cannot read which sessions exist out of the difference between 403 and
 * 404.
 *
 * `handleMcp` keeps a stricter Origin rule of its own on top of this one; see
 * the comment there.
 */
export function createOriginGuard(options: {
  allowedOrigins: readonly string[];
  host: string;
  hostAliases: () => ReadonlySet<string>;
}): (headers: Record<string, string | string[] | undefined>) => number | null {
  const { allowedOrigins, host, hostAliases } = options;

  return function guard(headers) {
    /*
      Absent is the ordinary case and the only one a legitimate caller produces:
      `claude`, the status line's `curl`, and the MCP host all send no `Origin`.
      Present-and-listed exists for a local dev server someone points at this
      app on purpose; with the default empty list, present is always a refusal —
      which is exactly the rule `POST /mcp` has enforced alone since HIVE-130.
    */
    const origin = headers['origin'];
    if (origin !== undefined) {
      if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return 403;
    }

    /*
      `Host` is `host[:port]`. Only the host part is compared: the port is this
      receiver's own and is already settled by the connection having arrived, so
      checking it would add nothing and would break the moment an ephemeral port
      changed. An IPv6 literal keeps its brackets, which is how it arrives and
      what `isLoopbackHost` strips.
    */
    const raw = headers['host'];
    // HTTP/1.1 requires it. A request without one is hand-rolled, and no caller
    // here is.
    if (typeof raw !== 'string' || raw === '') return 403;
    const claimed = raw.startsWith('[')
      ? raw.slice(0, raw.indexOf(']') + 1)
      : (raw.split(':')[0] ?? '');
    const bare = claimed.toLowerCase();
    if (bare === '') return 403;

    /*
      Loopback names are admitted whatever the bind, because a caller on this
      machine legitimately addresses loopback and always has. That is wider than
      the configured address deliberately: what a client may *claim* to have
      reached is not the same set as what a user may *configure* as a listen
      address, which is why `::1` is here and `isHostAlias` refuses it there.
    */
    if (isLoopbackHost(bare)) return null;
    if (bare === host.toLowerCase()) return null;
    /*
      And every alias, or a diverged session 403s: a containerised session
      addresses this app by whichever alias *it* was generated with — the
      global one, its project's, or its agent's — so the guard has to admit
      all three, not just the global setting (see `hostAliases`'s own doc
      comment above for why one was never enough). Read through the getter
      rather than captured, because the set can change under a config reload
      or a folder change while this socket stays up.
    */
    for (const alias of hostAliases()) {
      if (bare === alias.toLowerCase()) return null;
    }

    return 403;
  };
}

/**
 * Constant-time string compare, with the length check `timingSafeEqual` needs.
 *
 * `timingSafeEqual` throws on a length mismatch, so the guard in front of it is
 * not an optimisation — it is what keeps a short value from being an exception
 * instead of a refusal.
 */
export function secretEquals(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
