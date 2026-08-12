import { projectAccess } from '@lib/project-config';

/**
 * Which runtime is this (story 083)?
 *
 * **Electron is the product. The browser build is a chrome-only shell.**
 *
 * It used to be a *demo*: the store booted with ten seeded sessions, five
 * projects and eight tickets, so `pnpm dev` opened on something that looked like
 * a working command center. That seed loaded on the desktop too, which is what
 * made the real app count a fleet nobody had started, and removing it took the
 * demo with it. A browser has no bridge, so it has no PTYs, no config file and
 * no Jira — and now nothing pretending otherwise.
 *
 * What it still buys is real: the shell, the rails, the theme, the layout and
 * every empty state are developable and testable without spawning a process, and
 * `tests/e2e/web/` covers exactly that. Anything involving a session belongs in
 * `tests/e2e/electron/`, where sessions exist.
 *
 * It survives on one condition — **it must degrade visibly.** A browser build
 * that looks identical to the desktop build while its terminals are recordings
 * is a trap, first for the user and then for us, the moment someone files a bug
 * against a transcript. That is what {@link DEMO_PLACEHOLDER} and the `demo`
 * chip are for, and why they stayed when the fixtures went.
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
 * `spawn` verb today, which story 083's degradation table proposed. Gating those
 * would protect nothing that is not already protected: both go through
 * `useProjects()`, which reads the config, and a browser has no config — so the
 * picker there is empty and the console's `spawn` refuses by name, without a
 * capability check being consulted at all.
 *
 * The degradation that *is* real — the terminals are recordings — is carried
 * by {@link DEMO_PLACEHOLDER} and the `demo` chip, where a user actually
 * encounters it.
 */
export const can = {
  spawnSession: isDesktop,
  killSession: isDesktop,
  typeIntoTerminal: isDesktop,
  /**
   * The project-level answer story 090 adds: desktop **and** mapped **and**
   * resolvable.
   *
   * It is the one capability wired to a real surface today, because it gates
   * something that genuinely cannot work — a PTY with no `cwd`.
   *
   * With no config snapshot it answers `true`, which is what keeps the first
   * frames of a desktop launch usable before the config has been read. The
   * reasoning is in {@link projectAccess}; the short version is that "not read
   * yet" is not "not mapped", and refusing on the difference would flash a
   * refusal at every launch.
   */
  spawnSessionIn: (projectId: string): boolean =>
    projectAccess(projectId).spawnable,
} as const;

/**
 * The one place a desktop-only refusal is worded, so the surfaces that come to
 * need it (094–097) cannot drift into three explanations of one limitation.
 */
export const DESKTOP_ONLY_REASON = 'this requires the desktop app';

/** What the message row says when the transcript is a recording. */
export const DEMO_PLACEHOLDER = 'demo mode — this transcript is a recording';
