// @vitest-environment node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn as spawnPty } from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTAINER_MCP_FILE,
  CONTAINER_SESSIONS_SUBDIR,
  CONTAINER_SETTINGS_FILE,
  containerOrigins,
  writeSessionContainerFiles,
  writeSharedContainerFiles,
} from '../../electron/main/container/generated';
import { createReceiver } from '../../electron/main/hooks/receiver';
import { createLedger } from '../../electron/main/ledger';
import { mcpConfig } from '../../electron/main/mcp/config';
import { PLUGIN_DIR } from '../../electron/main/skills/paths';
import { writePluginDir } from '../../electron/main/skills/plugin';
import type { SkillsRead } from '../../electron/main/skills/read';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookStatusEvent,
} from '../../electron/shared/hook-contract';

/**
 * The container session profile, end to end (HIVE-133).
 *
 * Everything about `container` that can be asserted against a fake — the
 * `{env}` substitution, the path map, the generated `exec-env`/`rewrite`
 * file sets — already is, in `tests/electron/main/sessions/`,
 * `tests/electron/main/container/` and friends. None of it proves the thing
 * a containerised session actually depends on: that `docker exec` really
 * carries an environment across, that the paths this app writes really
 * resolve on the other side of that boundary, and — the case no staged
 * buffer can settle — that a resize typed at the host's terminal really
 * reaches the container's.
 *
 * Split into two gates behind two different prerequisites, not two tiers of
 * importance:
 *
 * - **mechanism** needs only a container and a shell — plain `alpine:3` — and
 *   runs whenever Docker is up.
 * - **claude** needs an image with a real `claude` installed —
 *   `tests/live/container/Dockerfile` builds one — and a credential to run it
 *   with. Naming that image is the user's job; this app never builds or bakes
 *   one. Unset, those cases are skipped, and the report says so.
 *
 * ```
 * pnpm test:container
 * HIVE_LIVE_CONTAINER_IMAGE=hive-claude:2.1.263 CLAUDE_CODE_OAUTH_TOKEN=… pnpm test:container
 * ```
 */
const RUN = process.env.HIVE_LIVE_CONTAINER_PROOF === '1';

/*
 * An image with `claude` installed, for the two cases that need one. Unset is
 * the ordinary case and skips them rather than failing: a developer's images
 * are alpine, postgres and friends, and building a `claude` image is not
 * something a test suite should do behind the user's back.
 */
const CLAUDE_IMAGE = process.env.HIVE_LIVE_CONTAINER_IMAGE;

/* A shell is all the mechanism cases need — no `claude`, no custom image. */
const IMAGE = 'alpine:3';
/* Unique per process and per run, so a crashed previous run cannot collide. */
const NAME = `hive-conformance-${process.pid}-${Date.now()}`;

const hasDocker = (): boolean =>
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

/**
 * Everything this suite hands a container, set **explicitly**.
 *
 * `tests/live` spreads `process.env` in every suite, so a developer running
 * this inside a Hive session would otherwise inherit that app's receiver and
 * POST this test's token to it. The symptom is a 403 that blames the token and
 * says nothing about the URL — see `done-conformance.test.ts:155-163`, which
 * documents the same trap for the same reason.
 */
const hiveEnv = (overrides: Record<string, string>): Record<string, string> => ({
  HIVE_SESSION_ID: '',
  HIVE_HOOK_TOKEN: '',
  HIVE_RECEIVER_URL: '',
  HIVE_RUN_ID: '',
  ...overrides,
});

/**
 * `hiveEnv`, plus everything `docker` itself needs to be found and run.
 *
 * `node-pty`'s `env` option **replaces** the spawned process's environment
 * rather than extending it — unlike a login shell, which inherits by default
 * — so a bare `hiveEnv({})` here hands `docker` a `PATH`-less environment and
 * it is never found (`execvp` fails, the pty exits 1 with no output). Only
 * the two `node-pty` spawns below need this: the `docker exec -e …` case
 * builds its flag list from `hiveEnv` directly and never touches the spawned
 * process's own environment.
 */
const ptyEnv = (overrides: Record<string, string>): Record<string, string | undefined> => ({
  ...process.env,
  ...hiveEnv(overrides),
});

/** Run a command inside the container and return its stdout. */
const inContainer = (script: string): string =>
  execFileSync('docker', ['exec', NAME, 'sh', '-c', script], {
    encoding: 'utf8',
  }).trim();

/** No custom skills — only the generated *paths* are under test here. */
const NO_SKILLS: SkillsRead = { skills: [], invalid: [] };

describe.skipIf(!RUN)('container conformance — mechanism', () => {
  let userData: string;

  beforeAll(async () => {
    if (!hasDocker()) {
      throw new Error(
        'docker is not available — this suite needs a real runtime. Start Docker, or unset HIVE_LIVE_CONTAINER_PROOF.',
      );
    }

    userData = mkdtempSync(join(tmpdir(), 'hive-container-'));

    /*
      The two writers a real launch calls before a containerised session ever
      spawns (HIVE-132, HIVE-133) — run here exactly as the app runs them, so
      "resolves inside the container" below is about the paths a session
      actually gets rather than an empty directory this suite invented.
    */
    await writeSharedContainerFiles(userData, {
      url: 'http://127.0.0.1:0/hook',
      origin: 'http://127.0.0.1:0',
    });
    await writePluginDir(join(userData, PLUGIN_DIR), '0.0.0-test', NO_SKILLS);

    execFileSync('docker', [
      'run', '-d', '--name', NAME,
      '-v', `${join(userData, 'hive')}:/hive:ro`,
      IMAGE, 'sleep', 'infinity',
    ]);
  }, 120_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    rmSync(userData, { recursive: true, force: true });
  });

  it('carries all three variables across the boundary', () => {
    const env = hiveEnv({
      HIVE_SESSION_ID: 'hero-refresh',
      HIVE_HOOK_TOKEN: 'a3f',
      HIVE_RECEIVER_URL: 'http://host.docker.internal:63999',
    });

    const args = Object.entries(env)
      .filter(([, value]) => value !== '')
      .flatMap(([name, value]) => ['-e', `${name}=${value}`]);

    const seen = execFileSync(
      'docker',
      [
        'exec',
        ...args,
        NAME,
        'sh',
        '-c',
        'echo "$HIVE_SESSION_ID|$HIVE_HOOK_TOKEN|$HIVE_RECEIVER_URL"',
      ],
      { encoding: 'utf8' },
    ).trim();

    expect(seen).toBe('hero-refresh|a3f|http://host.docker.internal:63999');
  });

  it('names generated files at paths that resolve inside the container', () => {
    // Written by `writeSharedContainerFiles` and `writePluginDir` above, under
    // `<userData>/hive`, mounted here at `/hive`.
    for (const file of [
      '/hive/container/claude-hooks.settings.json',
      '/hive/container/hive.mcp.json',
      '/hive/plugin',
    ]) {
      expect(inContainer(`test -e ${file} && echo ok`)).toBe('ok');
    }
  });

  it(
    'allocates a real TTY with -it, which -i alone does not',
    async () => {
      /*
        `-i` alone hands the container a pipe, not a terminal: `isatty()` is
        false and a TUI either refuses interactive mode or renders wrong. A
        plain child process proves this half — its own stdin need not be a
        terminal for docker to satisfy `-i`.
      */
      const withoutTty = execFileSync(
        'docker',
        ['exec', '-i', NAME, 'sh', '-c', 'test -t 0 && echo tty || echo pipe'],
        { encoding: 'utf8' },
      ).trim();

      expect(withoutTty).toBe('pipe');

      /*
        `-t` is the other half, and it is where a plain child process stops
        being able to prove anything: docker refuses to attach a TTY-enabled
        exec to a client whose own stdin is not itself a terminal — exactly
        what a test runner's stdin is. A pty is what the real spawn path gives
        it (`node-pty` under the login shell), so it is what this assertion
        needs too.
      */
      const withTty = await new Promise<string>((resolve, reject) => {
        const pty = spawnPty(
          'docker',
          ['exec', '-it', NAME, 'sh', '-c', 'test -t 0 && echo tty || echo pipe'],
          { cols: 80, rows: 24, env: ptyEnv({}) },
        );

        let out = '';
        pty.onData((data) => {
          out += data;
        });
        pty.onExit(({ exitCode }) => {
          if (exitCode !== 0) {
            reject(new Error(`docker exec -it exited ${exitCode}:\n${out}`));
            return;
          }
          resolve(out);
        });
      });

      expect(withTty).toContain('tty');
    },
    30_000,
  );

  it(
    'propagates a resize into the container TTY',
    () => {
      // The case no staged buffer can prove: whether SIGWINCH crosses xterm →
      // node-pty → `docker exec -t` into the container. A `claude` that
      // believes it has eighty columns forever is a bad first impression.
      const pty = spawnPty(
        'docker',
        ['exec', '-it', NAME, 'sh', '-c', 'sleep 2; stty size'],
        { cols: 80, rows: 24, env: ptyEnv({}) },
      );

      let out = '';
      pty.onData((data) => {
        out += data;
      });

      pty.resize(132, 40);

      return new Promise<void>((resolve) => {
        pty.onExit(() => {
          expect(out).toContain('132');
          resolve();
        });
      });
    },
    30_000,
  );
});

/*
  The cases that need a real `claude` **inside** the container, behind their
  own gate.

  Split from the four above rather than folded in with them, because they have
  a different prerequisite: those need only a container, these need an image
  with `claude` installed. `tests/live/container/Dockerfile` builds one — the
  app never does, a container is the user's to bring — and the credential is
  supplied at run time, never baked: whichever of `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_API_KEY` is set in this process is forwarded to `docker run`, the
  same two variables `claude` itself honours.

  ```
  docker build -t hive-claude:2.1.263 tests/live/container
  HIVE_LIVE_CONTAINER_IMAGE=hive-claude:2.1.263 CLAUDE_CODE_OAUTH_TOKEN=… pnpm test:container
  ```

  What only this half can prove, and the unit suites cannot:

  - that a `claude` on the far side of `docker exec` reaches the receiver at
    all — the receiver binds loopback, and `hostAlias` exists because loopback
    means something else inside a container;
  - that the identity the app puts in the environment (`exec-env`) or on disk
    (`rewrite`) is the one the receiver sees, for hooks and for MCP alike;
  - that a `rewrite` set rewritten after a restart re-authenticates a container
    that never stopped, and that the token it replaced is refused.
*/
describe.skipIf(!RUN || CLAUDE_IMAGE === undefined)('container conformance — claude', () => {
  const HOST_SESSION = 'host-live';
  const CONTAINER_SESSION = 'container-live';
  /*
    Docker Desktop's name for the host. Proven above the way `hostAlias`
    promises: `getent hosts host.docker.internal` resolves inside a container,
    and a server bound to the host's `127.0.0.1` answers through it.
  */
  const ALIAS = 'host.docker.internal';
  const CNAME = `${NAME}-claude`;
  /* Where `<userData>/hive` is mounted; the `hiveDir` of a real container block. */
  const HIVE_DIR = '/hive';

  let dir: string;
  let ledger: ReturnType<typeof createLedger>;
  let receiver: ReturnType<typeof createReceiver>;
  /** Everything the receiver attributed to a session, by session id. */
  const seen: { events: HookStatusEvent[]; ready: string[] } = { events: [], ready: [] };
  let hostMcpConfig: string;

  /**
   * A receiver that knows both sessions and records who spoke.
   *
   * Made twice in the `rewrite` case, because a second receiver *is* a
   * restart: `createReceiver` mints a fresh `launchSecret`, so every token it
   * derives differs from the first one's — the exact thing the per-session
   * set has to catch up with.
   */
  const startReceiver = async (): Promise<ReturnType<typeof createReceiver>> => {
    const created = createReceiver({
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
      onAgentsList: () => Promise.resolve({ agents: [] }),
      knowsSession: (id: string) => id === HOST_SESSION || id === CONTAINER_SESSION,
      knowsAgent: () => false,
      onAgentEvent: () => undefined,
      onEvent: (event) => {
        seen.events.push(event);
      },
      onReady: (entityId) => {
        seen.ready.push(entityId);
      },
      onTicketIntent: () => undefined,
      onPromptName: () => {},
      onCleared: () => undefined,
      onMetrics: () => undefined,
      onDone: () => undefined,
    });
    await created.start();
    expect(created.origin).not.toBeNull();
    expect(created.url).not.toBeNull();
    return created;
  };

  /** The receiver's URLs as the *container* must address them. */
  const aliased = (r: ReturnType<typeof createReceiver>) =>
    containerOrigins(
      {
        url: r.url ?? '',
        origin: r.origin ?? '',
        ...(r.readyUrl === null ? {} : { readyUrl: r.readyUrl }),
      },
      ALIAS,
    );

  beforeAll(async () => {
    if (!hasDocker()) {
      throw new Error(
        'docker is not available — this suite needs a real runtime. Start Docker, or unset HIVE_LIVE_CONTAINER_PROOF.',
      );
    }

    dir = mkdtempSync(join(tmpdir(), 'hive-container-claude-'));
    ledger = createLedger({
      dir: join(dir, 'ledger'),
      knowsParty: (party: string) => party === HOST_SESSION || party === CONTAINER_SESSION,
    });
    receiver = await startReceiver();

    /*
      The shared `exec-env` set and the plugin, written exactly as a launch
      writes them (HIVE-132, HIVE-96) — addressed by the alias, which is what
      `hooks/index.ts` does before calling the same writer.
    */
    await writeSharedContainerFiles(dir, aliased(receiver));
    await writePluginDir(join(dir, PLUGIN_DIR), '0.0.0-test', NO_SKILLS);

    /* The host session's own config: stdio, through the built MCP host. */
    hostMcpConfig = join(dir, 'host.mcp.json');
    writeFileSync(
      hostMcpConfig,
      mcpConfig({
        execPath: process.execPath,
        scriptPath: join(process.cwd(), 'out', 'main', 'mcp-host.js'),
      }),
      'utf8',
    );

    /*
      One container for every case, started the way a user starts theirs and
      left running throughout — the `rewrite` case is *about* a container that
      outlives the app. Read-only mount, because nothing in either set needs
      the container to write.
    */
    const credential = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .filter((name) => process.env[name] !== undefined && process.env[name] !== '')
      .flatMap((name) => ['-e', name]);
    execFileSync('docker', [
      'run', '-d', '--name', CNAME,
      '-v', `${join(dir, 'hive')}:${HIVE_DIR}:ro`,
      ...credential,
      CLAUDE_IMAGE ?? '',
      'sleep', 'infinity',
    ]);
  }, 120_000);

  afterAll(async () => {
    spawnSync('docker', ['rm', '-f', CNAME], { stdio: 'ignore' });
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  interface ClaudeRun {
    /** Every MCP server the binary reported at init, with its status. */
    servers: { name: string; status: string }[];
    /** The final answer. */
    text: string;
  }

  /**
   * `--output-format stream-json`, parsed rather than read as prose.
   *
   * The init event is the one place `claude` states, in its own words, whether
   * it reached the MCP server. Measured against 2.1.263: `connected`;
   * `needs-auth` when the server answered 403, which is what the receiver says
   * to a wrong token; `failed` when it could not be reached at all — a broken
   * alias, proven by running this file with one. Three answers, three causes,
   * which is what lets the stale-token case below tell a refusal from an
   * outage. Asking the model what tools it has is the thing this avoids: the
   * answer is a guess, and a guess in a test is a test that passes for the
   * wrong reason.
   */
  const parseRun = (raw: string): ClaudeRun => {
    let servers: ClaudeRun['servers'] = [];
    let text = '';
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event['type'] === 'system' && event['subtype'] === 'init') {
        servers = (event['mcp_servers'] as ClaudeRun['servers'] | undefined) ?? [];
      }
      if (event['type'] === 'result' && typeof event['result'] === 'string') {
        text = event['result'];
      }
    }
    return { servers, text };
  };

  const collect = (
    file: string,
    args: string[],
    env: Record<string, string | undefined>,
  ): Promise<ClaudeRun> =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      // Drained, not merely piped — a full pipe blocks the child forever.
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${file} exited ${String(code)}: ${err.slice(0, 2000)}\n${out.slice(0, 2000)}`));
          return;
        }
        resolve(parseRun(out));
      });
    });

  /** The flags every run shares; the same fence `ledger-conformance` documents. */
  const claudeFlags = (mcp: string, settings: string, prompt: string): string[] => [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--settings', settings,
    '--mcp-config', mcp,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__hive__*',
    '--disallowedTools', 'Bash',
    '--model', 'haiku',
    prompt,
  ];

  /**
   * `claude` inside the container, through `docker exec` — the transport a
   * container session really uses, minus the pty, which the mechanism gate
   * above already proves.
   *
   * `env` is spelled as `-e` flags, exactly as `expandEnvArgs` spells it on the
   * real command line. Empty for a `rewrite` run: that mode's whole point is
   * that the set carries the identity itself.
   */
  const runInContainer = (
    prompt: string,
    set: string,
    env: Record<string, string> = {},
  ): Promise<ClaudeRun> =>
    collect(
      'docker',
      [
        'exec',
        ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        CNAME,
        'claude',
        ...claudeFlags(
          `${set}/${CONTAINER_MCP_FILE}`,
          `${set}/${CONTAINER_SETTINGS_FILE}`,
          prompt,
        ),
        '--plugin-dir', `${HIVE_DIR}/${PLUGIN_DIR.replace(/^hive\//, '')}`,
      ],
      ptyEnv({}),
    );

  /** The host session: the same receiver, reached over loopback and stdio. */
  const runOnHost = (prompt: string, settings: string): Promise<ClaudeRun> =>
    collect('claude', claudeFlags(hostMcpConfig, settings, prompt), {
      ...process.env,
      [HOOK_ENV_SESSION]: HOST_SESSION,
      [HOOK_ENV_TOKEN]: receiver.tokenFor(HOST_SESSION),
      [HOOK_ENV_RECEIVER_URL]: receiver.origin ?? '',
    });

  /** What the ledger on disk holds from one party — the host's view of the truth. */
  const bodiesFrom = (from: string): string[] =>
    ledger
      .read({ from })
      .entries.map((entry) => entry.body);

  const hiveStatus = (run: ClaudeRun): string | undefined =>
    run.servers.find((server) => server.name === 'hive')?.status;

  it(
    'reads a container session ledger post from a host session, and the reverse (exec-env)',
    async () => {
      const shared = `${HIVE_DIR}/container`;
      const identity = {
        [HOOK_ENV_SESSION]: CONTAINER_SESSION,
        [HOOK_ENV_TOKEN]: receiver.tokenFor(CONTAINER_SESSION),
        [HOOK_ENV_RECEIVER_URL]: aliased(receiver).origin,
      };

      // Container → host. The `${VAR}`s in the shared set resolve from `-e`.
      const posted = await runInContainer(
        'Call ledger_post once with the body "posted from inside the container", then reply DONE.',
        shared,
        identity,
      );
      expect(hiveStatus(posted)).toBe('connected');
      expect(bodiesFrom(CONTAINER_SESSION)).toContain('posted from inside the container');

      /*
        The hooks crossed too, not only MCP: the http handlers in the mounted
        settings file carry `$HIVE_SESSION_ID`/`$HIVE_HOOK_TOKEN` through
        `allowedEnvVars`, and the `SessionStart` command hook `curl`s the ready
        URL through the alias. Either arriving attributed to the container's
        session is the identity crossing the boundary.
      */
      const fromContainer =
        seen.ready.includes(CONTAINER_SESSION) ||
        seen.events.some((event) => event.entityId === CONTAINER_SESSION);
      expect(fromContainer).toBe(true);

      // Host → container, through the built stdio host on this side.
      const hostSettings = join(dir, 'hive', 'claude-hooks.settings.json');
      writeFileSync(hostSettings, '{}\n', 'utf8');
      await runOnHost(
        'Call ledger_post once with the body "posted from the host", then reply DONE.',
        hostSettings,
      );
      expect(bodiesFrom(HOST_SESSION)).toContain('posted from the host');

      const readInContainer = await runInContainer(
        'Call ledger_read once, then reply with the exact body text of every entry whose from is "host-live", verbatim, one per line.',
        shared,
        identity,
      );
      expect(readInContainer.text).toContain('posted from the host');

      const readOnHost = await runOnHost(
        'Call ledger_read once, then reply with the exact body text of every entry whose from is "container-live", verbatim, one per line.',
        hostSettings,
      );
      expect(readOnHost.text).toContain('posted from inside the container');
    },
    600_000,
  );

  it(
    'authenticates an existing container after a Hive restart in rewrite mode, and refuses the token it replaced',
    async () => {
      const set = `${HIVE_DIR}/${CONTAINER_SESSIONS_SUBDIR}/${CONTAINER_SESSION}`;
      const identityFor = (r: ReturnType<typeof createReceiver>) => ({
        session: CONTAINER_SESSION,
        token: r.tokenFor(CONTAINER_SESSION),
      });

      // Before: the set carries receiver 1's token, and no `-e` is passed.
      await writeSessionContainerFiles(dir, CONTAINER_SESSION, aliased(receiver), identityFor(receiver), {
        containerRoot: set,
      });
      const before = await runInContainer(
        'Call ledger_post once with the body "before the restart", then reply DONE.',
        set,
      );
      expect(hiveStatus(before)).toBe('connected');
      expect(bodiesFrom(CONTAINER_SESSION)).toContain('before the restart');

      /*
        The restart. A new receiver is a new `launchSecret` and a new port —
        both of which the container, still running, knows nothing about. The
        old receiver goes down the way the app's would.
      */
      const first = receiver;
      receiver = await startReceiver();
      await first.stop();
      expect(receiver.tokenFor(CONTAINER_SESSION)).not.toBe(first.tokenFor(CONTAINER_SESSION));

      // The stale identity, kept beside the live one: the new origin with the
      // *old* token, so a refusal below is about the token and not the socket.
      const stale = `${HIVE_DIR}/${CONTAINER_SESSIONS_SUBDIR}/stale`;
      await writeSessionContainerFiles(dir, 'stale', aliased(receiver), identityFor(first), {
        containerRoot: stale,
      });

      // Rewritten for the same session — what `writeContainerSession` does on
      // the next spawn — and the same container authenticates again.
      await writeSessionContainerFiles(dir, CONTAINER_SESSION, aliased(receiver), identityFor(receiver), {
        containerRoot: set,
      });
      const after = await runInContainer(
        'Call ledger_post once with the body "after the restart", then reply DONE.',
        set,
      );
      expect(hiveStatus(after)).toBe('connected');
      expect(bodiesFrom(CONTAINER_SESSION)).toContain('after the restart');

      // And the old token, against the same receiver, is refused.
      const countBefore = (bodiesFrom(CONTAINER_SESSION)).length;
      const refused = await runInContainer(
        'Call ledger_post once with the body "with the stale token", then reply DONE.',
        stale,
      );
      expect(hiveStatus(refused)).toBe('needs-auth');
      expect(bodiesFrom(CONTAINER_SESSION)).toHaveLength(countBefore);
      expect(bodiesFrom(CONTAINER_SESSION)).not.toContain('with the stale token');
    },
    600_000,
  );
});
