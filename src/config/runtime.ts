import { projectAccess, projectConfigSnapshot } from '@lib/project-config';
import { DEFAULT_REMOTE, type RemoteConfig } from '@shared/config-contract';
import { CH } from '@shared/ipc-contract';
import { WINDOW_BOUND } from '@shared/remote-contract';

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
/**
 * The four capabilities `WINDOW_BOUND` (`electron/shared/remote-contract.ts`)
 * refuses while this window is attached to someone else's Hive (HIVE-144).
 *
 * One field per table entry, on purpose: `configChooseDirectory`,
 * `skillsFileImport`, `themePick`, `themeSave` each dereference the Electron
 * event to resolve a parent `BrowserWindow` for a native dialog, and a server
 * opens no window. Four capabilities collapsing to one boolean is exactly the
 * shape a careless gate takes — see `tests/config/runtime.test.ts`'s own
 * guard-rail test, which ties this shape's key count to `WINDOW_BOUND`'s so a
 * fifth channel there cannot be forgotten here and one cannot be silently
 * dropped from here either.
 */
export interface RemoteCapabilities {
  chooseDirectory: boolean;
  pickTheme: boolean;
  saveTheme: boolean;
  importSkillFiles: boolean;
}

/**
 * The pure predicate, kept separate from {@link can} so it can be proven
 * against a bare `{ mode }` in a unit test without a bridge, a snapshot or a
 * subscription in sight.
 *
 * `Pick<RemoteConfig, 'mode'>` rather than the whole block: the answer never
 * depends on `host` or `port`, and a narrower parameter is what lets a test
 * pass `{ mode: 'remote' }` on its own.
 */
export function canFor(remote: Pick<RemoteConfig, 'mode'>): RemoteCapabilities {
  const attached = remote.mode === 'remote';
  return {
    chooseDirectory: !attached,
    pickTheme: !attached,
    saveTheme: !attached,
    importSkillFiles: !attached,
  };
}

/**
 * The one place each of the four refusals is worded for the renderer, so a
 * disabled control's copy cannot drift from what the server would actually
 * have said. Indexed straight off {@link WINDOW_BOUND} rather than
 * paraphrased, which is what makes agreement automatic rather than a thing to
 * remember on the next edit to either side.
 */
export const REMOTE_DISABLED_REASON = {
  chooseDirectory: WINDOW_BOUND[CH.configChooseDirectory],
  pickTheme: WINDOW_BOUND[CH.themePick],
  saveTheme: WINDOW_BOUND[CH.themeSave],
  importSkillFiles: WINDOW_BOUND[CH.skillsFileImport],
} as const;

/** `snapshot.remote`, or `DEFAULT_REMOTE` ('local') before one has been read. */
const currentRemote = (): Pick<RemoteConfig, 'mode'> =>
  projectConfigSnapshot()?.remote ?? DEFAULT_REMOTE;

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
  /**
   * The four `WINDOW_BOUND` predicates (HIVE-144). See {@link canFor} for the
   * pure rule and {@link RemoteCapabilities} for why there are exactly four.
   *
   * Permissive with no snapshot, matching {@link spawnSessionIn}'s own
   * reasoning: `DEFAULT_REMOTE.mode` is `'local'`, so "not read yet" answers
   * exactly as "never attached" does, rather than flashing every dialog
   * button disabled for a frame at every launch.
   */
  chooseDirectory: (): boolean => canFor(currentRemote()).chooseDirectory,
  pickTheme: (): boolean => canFor(currentRemote()).pickTheme,
  saveTheme: (): boolean => canFor(currentRemote()).saveTheme,
  importSkillFiles: (): boolean => canFor(currentRemote()).importSkillFiles,
} as const;

/**
 * The one place a desktop-only refusal is worded, so the surfaces that come to
 * need it (094–097) cannot drift into three explanations of one limitation.
 */
export const DESKTOP_ONLY_REASON = 'this requires the desktop app';

/** What the message row says when the transcript is a recording. */
export const DEMO_PLACEHOLDER = 'demo mode — this transcript is a recording';
