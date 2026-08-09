/**
 * The GitHub integration's contract.
 *
 * Separate from `ipc-contract.ts` for the reason `jira-contract.ts` is: the PR
 * poller brings its own vocabulary — states, findings, check rollups — and
 * folding it into the channel registry would make that file about pull requests
 * rather than about IPC. The same rules apply here as there: types and
 * constants only, no runtime imports, no Node APIs, no DOM APIs.
 *
 * ## Why the renderer's `Pr` type is not this type
 *
 * `electron/main/**` may not import `src/**`, so main could not produce a `Pr`
 * even if it wanted to. It is also the wrong shape: `Pr.session` names the
 * session that owns a PR, which is an app concern main knows nothing about. The
 * renderer resolves that from a branch match, in a selector — see
 * `usePrs()`. What crosses IPC is what GitHub said, mapped to named fields.
 */

/**
 * How far a PR has got. Mirrors the renderer's `PrListState` deliberately: the
 * badge rules in `features/shared/pr-presentation.ts` are the reason these four
 * exist, and a fifth here with no badge would render as nothing at all.
 */
export type GhPrState = 'open' | 'approved' | 'draft' | 'merged';

/** What CI is doing. `passing` also covers a repo with no checks at all. */
export type GhPrChecks = 'passing' | 'running' | 'failing';

/**
 * One pull request, as this app is willing to carry it across IPC.
 *
 * Every field is one a surface renders or resolves against. GitHub's PR payload
 * also carries the author's avatar, the body, the diff stats and a merge-state
 * enum; none of it crosses, because `gh.ts`'s rule is that only mapped, named
 * fields do.
 */
export interface PrRecord {
  number: number;
  title: string;
  /** The `https://github.com/...` page. The only URL any surface opens. */
  url: string;
  /** Short repo name — `the-hive`, not `owner/the-hive`. What the card shows. */
  repo: string;
  /** The owner, kept so two repos with one name stay distinguishable. */
  owner: string;
  /** `headRefName`. What a session's branch is matched against. */
  branch: string;
  state: GhPrState;
  /** Unresolved review threads. Bot or human — a finding is a finding. */
  findings: number;
  checks: GhPrChecks;
  /** ISO 8601, straight from GitHub. Used for ordering, never parsed for display. */
  updatedAt: string;
}

/**
 * Why a read produced nothing.
 *
 * The first three are **configuration**, not failure: they are what the panel
 * explains rather than what it apologises for. The renderer keys its
 * `unconfigured` state on exactly those three, so adding a fourth here without
 * deciding which side it falls on would silently make it an error.
 */
export type GhErrorKind =
  /** No `gh` on the `PATH` a session would search. */
  | 'not-installed'
  /** `gh` is there, but no account is logged in. */
  | 'unauthenticated'
  /** No configured project resolves to a GitHub repository. */
  | 'no-repos'
  | 'offline'
  | 'timeout'
  | 'rate-limited'
  | 'unknown';

export interface GhError {
  kind: GhErrorKind;
  /** Safe to show. Never a token, never raw command output. */
  message: string;
}

/**
 * Every GitHub verb answers with this rather than throwing across IPC.
 *
 * `gh.ts`'s rule again: the panel must render either way. A rail that throws
 * because GitHub is unreachable tells the user this app is broken, when the
 * truth is that GitHub is unreachable.
 */
export type GhResult<T> = { ok: true; value: T } | { ok: false; error: GhError };

/** What `github:prs` answers with. */
export interface PrsSnapshot {
  prs: PrRecord[];
  /** How many repositories were swept. Lets the panel say "0 repos" honestly. */
  repos: number;
}

/**
 * How long a merged PR stays on the panel.
 *
 * Twenty-four hours, and the number is a product decision rather than a
 * technical one: a merged row is there to confirm something landed, which is
 * only news for about a day. Without a window the panel would accumulate every
 * PR the account ever merged.
 */
export const GH_MERGED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many PRs are read per state, per sweep.
 *
 * **Per sweep, not per repository** — the search connections these size span
 * every configured project at once, where the aliased `repository` blocks they
 * replaced each had a page of their own. Both are first-page reads ordered by
 * `sort:updated-desc`, with no paging.
 *
 * A hundred each is search's own maximum, and the cap is deliberately generous
 * rather than tight: the page is the *only* thing that can now drop a pull
 * request the user still cares about. A PR opened on a Friday and left untouched
 * sinks down an `updated-desc` list every time somebody else's moves, so the
 * headroom is what stops a quiet PR falling off while it waits. Reaching a
 * hundred means a hundred open pull requests of the user's own across every
 * project they have configured, which is a different problem than a panel solves.
 *
 * The cost is affordable at the poll rate: a hundred nodes each carrying
 * `reviewThreads(first: 100)` measures at two rate-limit points, so a sweep of
 * both connections is about four against an hourly budget of five thousand.
 */
export const GH_OPEN_PAGE = 100;
export const GH_MERGED_PAGE = 100;

/**
 * How many review threads are counted per PR.
 *
 * A cap rather than paging, for the same reason: the badge says "12 open
 * findings" the same way whether the true number is 12 or 112, and a second
 * round trip per PR to make an already-alarming number more precise is a poor
 * trade against a poll that runs every minute.
 */
export const GH_THREAD_PAGE = 100;
