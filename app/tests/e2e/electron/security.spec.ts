import { expect, test } from './fixtures/hive-app';

/**
 * What only `_electron` can assert (story 085).
 *
 * `app.evaluate()` runs in the **main process**, which is how the security
 * posture from story 082 becomes a test rather than a code-review note. No
 * browser driver can see `webPreferences`.
 */

test('the three non-negotiable webPreferences flags hold', async ({ hive, page }) => {
  await page.waitForSelector('header');

  const prefs = await hive.evaluate(({ BrowserWindow }) => {
    /**
     * `getLastWebPreferences()` exists at runtime in Electron 43 but was
     * dropped from the published typings, so it needs a cast. Verified present
     * before relying on it; the alternative — inferring the flags from what the
     * renderer cannot reach — proves `nodeIntegration` well and the other two
     * only circumstantially. This reads the values the window was actually
     * constructed with.
     */
    const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences?: () => {
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        sandbox?: boolean;
      } | null;
    };
    return contents.getLastWebPreferences?.() ?? null;
  });

  // If this ever comes back null the API moved — fail loudly rather than
  // passing three `undefined === undefined` comparisons.
  expect(prefs).not.toBeNull();
  expect(prefs?.contextIsolation).toBe(true);
  expect(prefs?.nodeIntegration).toBe(false);
  expect(prefs?.sandbox).toBe(true);
});

test('the renderer cannot reach Node', async ({ page }) => {
  await page.waitForSelector('header');

  const reachable = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
    Buffer: typeof (globalThis as Record<string, unknown>).Buffer,
    ipcRenderer: typeof (globalThis as Record<string, unknown>).ipcRenderer,
  }));

  expect(reachable).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    Buffer: 'undefined',
    ipcRenderer: 'undefined',
  });
});

test('window.hive exposes only the documented verbs', async ({ page }) => {
  await page.waitForSelector('header');

  const surface = await page.evaluate(() => ({
    top: Object.keys(window.hive!).sort(),
    pty: Object.keys(window.hive!.pty).sort(),
    config: Object.keys(window.hive!.config).sort(),
    session: Object.keys(window.hive!.session).sort(),
    integrations: Object.keys(window.hive!.integrations).sort(),
    fs: Object.keys(window.hive!.fs).sort(),
    github: Object.keys(window.hive!.github).sort(),
    notifications: Object.keys(window.hive!.notifications).sort(),
    jira: Object.keys(window.hive!.jira).sort(),
  }));

  // Widening any of these lists is the alarm this test exists to raise.
  /**
   * Story 106 adds two top-level namespaces, and the bound still holds.
   *
   * `integrations.status` is the first verb behind which main executes another
   * program, which is exactly the kind of addition this test exists to make
   * deliberate. What keeps it inside story 082's posture: it takes **no
   * argument at all**, so nothing from the renderer reaches the argv; main runs
   * a resolved absolute path with a constant argv and no shell, bounded by a
   * timeout; and it writes nothing and returns no token value — only which
   * source would supply one.
   *
   * `notifications.onActivate` is a listener, not a capability: main → renderer
   * only, and it grants the page nothing it could not already be told.
   */
  /**
   * HIVE-67 adds `jira`, and it is the first namespace that touches a secret.
   *
   * What keeps it inside story 082's posture, and what a reviewer should check
   * any future verb here against:
   *
   * - **No verb returns a token.** The renderer can write one and clear one.
   *   The list below is four long, and a fifth that read one back would have to
   *   be added here by hand — which is the whole point of asserting the exact
   *   set rather than a subset.
   * - **`test` takes no argument.** The host it reaches comes from
   *   `~/.hive/config.json`, read in main, so nothing on the call can redirect
   *   a request already going out. The renderer can still *change* the site
   *   through `config.setJira` — that is the settings pane's whole job, and it
   *   grants nothing the bridge does not already grant far more of through
   *   `setRuntime` and `pty.write`.
   * - **The credential never lives in the config file.** `config.setJira`
   *   carries a site and an email; the token goes to `safeStorage` on its own
   *   channel.
   */
  /**
   * The project explorer adds `fs`, and it is **the widest capability in this
   * bridge**: everything above it either writes one file main chose, talks to
   * one remote host, or drives a process the user started. This reads and
   * writes arbitrary files.
   *
   * What keeps it inside story 082's posture, and what a reviewer should check
   * any future verb here against:
   *
   * - **No verb takes a path.** Each names a `projectId` and a *relative*
   *   path; main resolves it against the directory it validated when it loaded
   *   the config. There is nowhere to put an absolute path.
   * - **Containment is re-checked after `realpath`.** A symlink inside the
   *   project pointing at `/etc` is a well-formed relative path, and only
   *   asking the filesystem where it goes settles it.
   * - **`writeFile` is not gated on the editor's read-only preference.** That
   *   preference lives in `localStorage`, which is writable by exactly the
   *   thing a capability check would be defending against. It gates the UI;
   *   containment gates the disk.
   */
  /**
   * `github` arrived with the live PRs panel and was **not** added to this list
   * by the branch that introduced it — so this assertion failed on that branch,
   * which is precisely what it is for. With no CI on this repository, the list
   * is the only thing standing between a widened bridge and a silent merge.
   *
   * What bounds it: one verb, taking **no argument at all**. Main sweeps the
   * repositories named in the user's own config through `gh`; the renderer
   * cannot name a repository, so this is a bounded read of what the user
   * already mapped rather than a general-purpose GitHub client.
   */
  expect(surface.top).toEqual([
    'appInfo',
    'config',
    'fs',
    'github',
    'integrations',
    'jira',
    'notifications',
    'pty',
    'session',
  ]);
  expect(surface.integrations).toEqual(['status']);
  expect(surface.github).toEqual(['prs']);
  expect(surface.fs).toEqual([
    'onChanged',
    'readDir',
    'readFile',
    'unwatch',
    'watch',
    'writeFile',
  ]);
  /**
   * **Pre-existing red, corrected here rather than left failing** — the same
   * call the `onName` note above records, for the same reason.
   *
   * HIVE-75 turned notifications into a real pipeline and added `list`,
   * `markRead`, `onNew` and `onRead` without updating this list, so the
   * assertion has been failing since that commit. It is unrelated to HIVE-78
   * and is fixed here only because a widened bridge landing in an
   * already-failing test is exactly the miss this test exists to prevent.
   *
   * What bounds the four: two listeners, which grant the page nothing it could
   * not be told; `list`, a read of a buffer main holds *for* the renderer,
   * which outlives the window; and `markRead`, whose only argument is an id or
   * `null`, and whose only effect is a flag on a row the renderer can already
   * see. None of them reaches the filesystem, a process, or the network.
   */
  expect(surface.notifications).toEqual([
    'list',
    'markRead',
    'onActivate',
    'onNew',
    'onRead',
  ]);
  expect(surface.jira).toEqual([
    /**
     * HIVE-70's `applyTransition` is the **first verb in this bridge that
     * writes to something outside this machine**, and it is the entry on this
     * list to look hardest at. What bounds it: the issue key and the transition
     * id are both pattern-matched in main, the endpoint is composed there and
     * cannot be named by the caller, and the request is attempted exactly once
     * — never retried, because a transition that may already have applied must
     * not be applied twice.
     */
    'addComment',
    'applyTransition',
    'clearToken',
    'comments',
    // HIVE-68's two reads. Both answer with mapped, named fields; neither
    // returns a token and neither takes a host.
    'issue',
    /**
     * HIVE-71's `links` and `comments` are reads; `addComment` is the only verb
     * in this bridge that sends **free text** to Jira. What bounds it: the
     * markdown is length-bounded and control-character-free at the guard, the
     * conversion to ADF happens in main so no document builder ships to the
     * renderer, and the result is validated against ADF's rules before a
     * request is made.
     */
    'links',
    'search',
    'setToken',
    'status',
    'test',
    'transitions',
  ]);
  expect(surface.pty).toEqual([
    // Story 093 added `ack` — the renderer reporting what it has parsed, which
    // is what lets main apply backpressure.
    'ack',
    'kill',
    'onData',
    'onExit',
    /**
     * Story 094 added `onLost`, and it is a *listener*, not a capability.
     *
     * The bridge grew a way to be told something, not a new thing the renderer
     * can do to this machine — which is the distinction that decides whether
     * widening this list is acceptable. Story 093 had to log a crashed host and
     * forward nothing; a terminal whose host died otherwise just stops
     * mid-line, indistinguishable from a process that is thinking.
     */
    'onLost',
    'resize',
    /**
     * Story 096 added `restart`, and it *is* a capability rather than a
     * listener — so it is the kind of addition this test exists to make
     * deliberate.
     *
     * It earns the widening by being the only way a session ever restarts.
     * Nothing auto-respawns: the transport keeps its "already requested" flag
     * set even after an exit, precisely so a tab switch can never resurrect a
     * finished agent. Restarting discards a running agent's context, so it has
     * to be a thing the user chose.
     */
    'restart',
    'spawn',
    'write',
  ]);
  /**
   * Story 090 added `config` read-only; story 101 makes it writable, and the
   * widening is deliberate and bounded.
   *
   * 090's comment here said no verb writes to the user's disk "because a
   * settings UI that writes this file is out of scope". Story 101 *is* that
   * settings UI, so the reasoning was right and the condition changed. What
   * bounds it: the bridge can write to exactly one file, no verb accepts a
   * destination path, and every path arriving from the renderer is re-validated
   * in main from scratch — `chooseDirectory` is a UX step, not a capability
   * grant.
   */
  /**
   * Story 102 adds three clone verbs, and they do not widen what the bound
   * above says. `startClone` takes a URL and a **parent** directory — main
   * derives the folder name from the URL itself — so still no verb accepts a
   * destination, and the only directory main will remove is one it computed and
   * created within a single clone.
   */
  /**
   * Story 103 adds three more, and the bound still holds. `renameProject` takes
   * a display string; `repointProject` takes a path the renderer got from
   * `chooseDirectory` and main re-validates from scratch; `reorderProjects`
   * takes ids and no path at all. Still exactly one file writable, still no
   * verb naming a destination.
   */
  expect(surface.config).toEqual([
    'addProject',
    'cancelClone',
    'chooseDirectory',
    /**
     * Story 104 added `diagnoseCommand`, and it is the *safest* kind of
     * addition this list can take: it writes nothing, takes no path, and only
     * stats files the config already names. It is here because the renderer
     * must not do its own filesystem lookup — the answer has to come from the
     * process that will actually spawn the session, or it describes an
     * environment nobody runs in.
     */
    'diagnoseCommand',
    'get',
    'onCloneDone',
    'reload',
    'removeProject',
    'renameProject',
    'reorderProjects',
    'repointProject',
    /**
     * Story 107's two verbs, and what makes them acceptable additions is that
     * **neither takes an argument at all**.
     *
     * `revealConfig` shows main's own `configPath()` in the OS file manager —
     * `showItemInFolder`, which selects a file in a folder window and cannot
     * launch a program. `resetConfig` rewrites that same file through the one
     * guarded write path every other mutation uses, so it is atomic, validated
     * by the reader's own parser, and mode- and symlink-preserving.
     *
     * Nothing arrives from the renderer on either channel. There is therefore
     * no payload guard to write, nothing to inject into, and no way for a
     * compromised renderer to aim either verb at a file main did not choose —
     * which is strictly stronger than the epic's "no verb takes a destination
     * path" rule rather than an exception to it.
     */
    'resetConfig',
    'revealConfig',
    /**
     * HIVE-67's connection settings — the site and the account email.
     *
     * Ordinary settings, written through the same guarded path as every other,
     * and notable here for what the payload does *not* carry: there is no
     * `token` key, and `parseSetJiraRequest` refuses one as an unexpected key.
     * A credential has no route into the file this verb writes.
     */
    'setJira',
    /**
     * Story 104's two mutating verbs, and they *are* capabilities — the kind
     * this test exists to make deliberate rather than accidental.
     *
     * What keeps them within story 082's posture: neither takes a destination,
     * so writes stay confined to the config file; `setProjectRuntime` names an
     * existing project by id and is refused if that id is not on disk; and the
     * env map — the one payload here that reaches process control — is checked
     * key by key against a whitelist pattern, with the terminal's own three
     * variables and `__proto__` refused outright.
     */
    /**
      * Story 106's `setNotifications` — a capability, and the mildest one on
      * this list. It carries three booleans, takes no path, and goes through
      * the same single write path as everything above it: the file the bridge
      * can write is still exactly one, and it is still not named by the caller.
      */
    'setNotifications',
    'setProjectRuntime',
    'setRuntime',
    'startClone',
  ]);
  /**
   * Story 096 added `session`, and it is a listener only. Main derives status
   * from pty output and pushes it; the renderer cannot ask for anything here.
   *
   * HIVE-61 added `onName` beside it — also main → renderer, also a thing the
   * page can be *told* rather than a thing it can do. It updated
   * `BRIDGE_SESSION_KEYS` and the preload surface test but not this list, so
   * this assertion has been failing since that commit. Corrected here rather
   * than left red: an assertion nobody believes is worse than no assertion,
   * because the next real widening would land in an already-failing test.
   *
   * `onCleared` is the third, and the same shape as the other two: a `/clear`
   * is something the page is *told* about. It grants the renderer no new verb
   * — it cannot end a session, only learn that one ended — so the "listener
   * only" property this assertion exists to pin is unchanged.
   *
   * HIVE-78 adds the fourth and fifth, and the property still holds — but they
   * are worth naming individually, because each carries something new *out* of
   * main and that is the direction this test is least equipped to notice.
   *
   * `onBranch` reports a branch and a working directory. Main learned both by
   * running `git rev-parse` in a directory a hook named, so the renderer is
   * being told a fact about a repository it already has the id of, and gains no
   * ability to read a path it could not already reach through `fs`.
   *
   * `onTicketIntent` is the one that deserved the hardest look: its input is
   * the user's **prompt**. It carries only a matched issue key — the prompt is
   * read inside the receiver and dropped — which is the whole reason main does
   * the matching rather than forwarding the text for the renderer to scan.
   * A channel that shipped prompts to the page would be a materially different
   * thing from a status side-channel, and this list is where that would show
   * up first.
   */
  expect(surface.session).toEqual([
    'onBranch',
    'onCleared',
    'onName',
    'onStatus',
    'onTicketIntent',
  ]);
});

test('ipcRenderer is not reachable through the bridge at any depth', async ({
  page,
}) => {
  await page.waitForSelector('header');

  const leaked = await page.evaluate(() => {
    const seen = new Set<unknown>();
    const walk = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return false;
      if (seen.has(value)) return false;
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (typeof record.invoke === 'function' && typeof record.on === 'function') {
        return true;
      }
      return Object.values(record).some(walk);
    };
    return walk(window.hive);
  });

  expect(leaked).toBe(false);
});

test('the bridge round-trips to the main process', async ({ page }) => {
  await page.waitForSelector('header');

  const info = await page.evaluate(() => window.hive!.appInfo());

  expect(info.platform).toBe(process.platform);
  expect(info.electron).toMatch(/^\d+\.\d+\.\d+/);
});

test('the production CSP is applied, with no unsafe-eval and no wildcard', async ({
  page,
}) => {
  await page.waitForSelector('header');

  const csp = await page.evaluate(async () => {
    const response = await fetch(location.href);
    return response.headers.get('content-security-policy');
  });

  expect(csp).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  // `connect-src 'self'` is what stops rendered terminal content from becoming
  // an exfiltration path.
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toContain('*');
});

test('window.open is denied', async ({ page }) => {
  await page.waitForSelector('header');

  const opened = await page.evaluate(() => window.open('https://example.com'));

  expect(opened).toBeNull();
});
