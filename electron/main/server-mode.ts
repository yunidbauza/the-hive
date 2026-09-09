/**
 * Whether this run of the app is a server (HIVE-144 review, I3).
 *
 * ## Why this is its own module
 *
 * The answer is `invocation.server || getConfig().server.enabled`, and only
 * `electron/main/index.ts` can compute it — `--server` is a command-line flag
 * nothing else parses. Two very different places need it: `ipc/router.ts`,
 * which must refuse to attach on a serving machine, and `ipc/index.ts`, which
 * reports it as `AppInfo.serving` so Settings can say so rather than leaving
 * a control that fails when clicked. Both already sit on each other's import
 * graph, and `import/no-cycle` is an error here, so the fact lives in a leaf
 * module that imports nothing and both can read.
 *
 * ## The interlock this exists for
 *
 * `RemoteConfig`'s own doc comment says an install is either the server or a
 * client and never a hybrid. Nothing enforced that, and the cost was not a
 * muddle but a permanent failure: `switchIpcMode`'s remote arm calls
 * `unbindEverything()` **synchronously before its first `await`**, which runs
 * `resetIpcHandlers({ flush: true })` → `void remoteListener?.stop();
 * remoteListener = null`. The listener is built inside `registerIpcHandlers`
 * and `.start()` is called from exactly one place, inside `whenReady`. So on a
 * machine that both serves and is configured to attach, the boot attach tore
 * the listener down before `whenReady` ever fired: `start()` was called on
 * `null`, no port was ever bound, and the tray went on claiming server mode.
 * A relaunch repeated it.
 *
 * **The interlock, not a preserved listener.** Keeping `remoteListener` alive
 * across a switch was the other candidate and it is worse: `resetIpcHandlers`
 * also clears `remoteRegistry` and `attachedSockets`, so the surviving socket
 * would accept a paired device's attach and then answer `not-ready` to every
 * call it made — a server that is up and useful for nothing, which is harder
 * to diagnose from the far end than one that is simply not listening. And a
 * machine that serves its PTYs to one peer while driving another's is a
 * credential-forwarding hop nobody designed. Refusing the combination is what
 * the contract already said; this makes it true.
 */

let serving = false;

/**
 * Declare this run's mode. Called once, from `electron/main/index.ts`, before
 * anything can attach — which on that file's own ordering means before
 * `registerIpc('local')`, because the boot attach follows immediately.
 */
export function setServerMode(on: boolean): void {
  serving = on;
}

/** Whether this run is a server. `false` until {@link setServerMode} says otherwise. */
export function isServerMode(): boolean {
  return serving;
}

/**
 * Test-only: put the flag back where a fresh process has it.
 *
 * Module state outlives a test file's `beforeEach`, and a suite that left this
 * `true` would make the next one's attach refuse for a reason it never set up.
 */
export function resetServerModeForTest(): void {
  serving = false;
}
