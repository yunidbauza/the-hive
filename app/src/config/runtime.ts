/**
 * Which runtime is this (story 083)?
 *
 * **Electron is the product. The browser build is a fixtures-only demo
 * surface.** It survives because the transport seam (story 042) already makes
 * it a branch on one factory, and it buys three real things: the six existing
 * Playwright web specs keep passing unchanged, a demo needs no install, and the
 * whole coordination UI stays developable without spawning processes.
 *
 * It survives on one condition — **it must degrade visibly.** A browser build
 * that looks identical to the desktop build while its terminals are recordings
 * is a trap, first for the user and then for us, the moment someone files a bug
 * against a transcript.
 */

/**
 * Feature-detect the bridge, not the user agent.
 *
 * Not `navigator.userAgent` (Electron's is a Chrome UA and lies by design), not
 * `process.versions.electron` (unreachable with `nodeIntegration: false`), and
 * not a build-time `import.meta.env` flag.
 *
 * The bridge **is** the capability. If it is there, PTYs are reachable; if it
 * is not, they are not — which stays true even if this exact bundle is ever
 * served to a browser from a dev server, where a build-time flag would confidently
 * claim otherwise.
 */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && window.hive !== undefined;

/**
 * Capability gating goes through one predicate object rather than scattered
 * `isDesktop()` calls in components.
 *
 * A component asks `can.spawnSession()`. When a capability later becomes
 * conditional on something *other* than the target — a missing config file
 * (story 090), for instance — it changes here and nowhere else.
 *
 * ## What these gate, and what they deliberately do not
 *
 * Each of these is about **a real process on a real machine**, and none of
 * that exists in either target yet. They are consumed when it does: the PTY
 * transport (094), the interactive terminal (095) and the orchestrator driving
 * real sessions (097).
 *
 * They are explicitly **not** wired to the new-session picker or the console's
 * `spawn` verb today, which story 083's degradation table proposed. In this
 * prototype "starting a session" adds a fixture entity with a recorded
 * transcript — it does not start a process — so gating it would remove the
 * demo surface's main flow while protecting nothing. It would also break five
 * of the six Playwright web specs, and story 083 names that as the signal that
 * the story is wrong rather than the specs.
 *
 * The degradation that *is* real — the terminals are recordings — is carried
 * by {@link DEMO_PLACEHOLDER} and the `demo` chip, where a user actually
 * encounters it.
 */
export const can = {
  spawnSession: isDesktop,
  killSession: isDesktop,
  typeIntoTerminal: isDesktop,
} as const;

/**
 * The one place a desktop-only refusal is worded, so the surfaces that come to
 * need it (094–097) cannot drift into three explanations of one limitation.
 */
export const DESKTOP_ONLY_REASON = 'this requires the desktop app';

/** What the message row says when the transcript is a recording. */
export const DEMO_PLACEHOLDER = 'demo mode — this transcript is a recording';
