// @vitest-environment node
import { execFileSync, spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { agentPromptFile, agentWorkdir, agentsRoot } from '../../electron/main/agents/paths';
import { createRunTracker, type ChildLike, type RunTracker } from '../../electron/main/agents/runs';
import { createAgentState, type AgentState } from '../../electron/main/agents/state';
import { createWakeCommand } from '../../electron/main/agents/wake-command';
import { createHookRuntime, type HookRuntime } from '../../electron/main/hooks';
import { createReceiver } from '../../electron/main/hooks/receiver';
import { createLedger, type Ledger } from '../../electron/main/ledger';
import { agentMcpConfigFile } from '../../electron/main/mcp';
import { mcpConfig } from '../../electron/main/mcp/config';
import { PLUGIN_DIR } from '../../electron/main/skills/paths';
import { writePluginDir } from '../../electron/main/skills/plugin';
import type { SkillsRead } from '../../electron/main/skills/read';
import type { RunLine } from '../../electron/shared/agent-contract';
import { CONFIG_PATH_ENV } from '../../electron/shared/config-contract';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookAgentEvent,
  type HookStatusEvent,
} from '../../electron/shared/hook-contract';
import { LEDGER_DIR, OVERMIND } from '../../electron/shared/ledger-contract';

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
        The hooks crossed too, not only MCP — and as *status* events, not only
        the ready `curl`. An earlier version of this assertion accepted either,
        and passed while every http hook from the container was being refused
        by the binary as a private address (HIVE-137, `statusCommand`): the
        ready command was the one that got through. Both are required now,
        because both are promised.
      */
      expect(seen.ready).toContain(CONTAINER_SESSION);
      expect(seen.events.some((event) => event.entityId === CONTAINER_SESSION)).toBe(true);

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

/*
  A containerised **agent** (HIVE-137), behind the same gate as the claude
  cases: the same image, the same credential rule, and the app's own agent
  runtime composed the way `ipc/index.ts` composes it — the hook runtime, the
  wake builder and the run tracker, with a real `spawn`. What only this can
  prove:

  - a wake becomes `docker exec …` and the run closes `done`, with its hooks
    arriving on the agent register and its ledger post carrying its name;
  - `approve` over HTTP saw the run's grants — the agent read its inbox and
    posted without a single permission card;
  - the second wake resumes the first's transcript, which lives inside the
    container's HOME;
  - a stop from the host reaches the process *inside* — measured earlier in
    this story: signalling the `docker exec` client alone does not;
  - a stopped container is a `failed` run whose reason is the runtime's own
    sentence, and nothing worse.
*/
describe.skipIf(!RUN || CLAUDE_IMAGE === undefined)('container conformance — agent', () => {
  const AGENT = 'pr-patrol';
  const CNAME = `${NAME}-agent`;
  const HIVE_DIR = '/hive';
  const WORKSPACE = '/work';

  let dir: string;
  let userData: string;
  let previousConfigPath: string | undefined;
  let ledger: Ledger;
  let hooks: HookRuntime;
  let agentState: AgentState;
  let runs: RunTracker;
  const agentEvents: HookAgentEvent[] = [];
  const spawns: { file: string; args: string[] }[] = [];
  const lines: RunLine[] = [];
  /** Resolved by `pushStatus` the moment the agent stops being `working`. */
  const settlers = new Map<string, () => void>();
  const settled = (name: string): Promise<void> =>
    new Promise((resolve) => settlers.set(name, resolve));

  const agentMd = (): string => `---
name: ${AGENT}
description: Proves a containerised wake end to end.
icon: GitPullRequest
wake:
  on: [ledger]
tools: [Bash]
autonomy: ask
limits:
  turns: 8
container:
  runtime: docker
  name: ${CNAME}
  workspace: ${WORKSPACE}
  hive_dir: ${HIVE_DIR}
---
You are a conformance probe. Do exactly what the wake prompt asks, using the
tool it names, and nothing more. Never ask a question.
`;

  const bodiesFrom = (from: string): string[] =>
    ledger.read({ from }).entries.filter((entry) => entry.kind === 'post').map((entry) => entry.body);

  /** `pgrep -f <uuid>` inside: the run's own argv carries the uuid. */
  const insideAlive = (uuid: string): boolean =>
    spawnSync('docker', ['exec', CNAME, 'pgrep', '-f', uuid], { stdio: 'ignore' }).status === 0;

  const sessionUuidOf = (args: readonly string[]): string => {
    const at = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
    return args[at + 1] ?? '';
  };

  beforeAll(async () => {
    if (!hasDocker()) {
      throw new Error(
        'docker is not available — this suite needs a real runtime. Start Docker, or unset HIVE_LIVE_CONTAINER_PROOF.',
      );
    }

    dir = mkdtempSync(join(tmpdir(), 'hive-container-agent-'));
    userData = join(dir, 'userData');
    /*
      Every path an agent touches derives from `configPath()`, which reads
      this variable per call — pointing it at a temp directory moves
      `~/.hive/agents`, the work dir and `agents.json` at once, so nothing
      here can reach the developer's own `~/.hive`.
    */
    previousConfigPath = process.env[CONFIG_PATH_ENV];
    process.env[CONFIG_PATH_ENV] = join(dir, '.hive', 'config.json');

    mkdirSync(join(agentsRoot(), AGENT), { recursive: true });
    writeFileSync(join(agentsRoot(), AGENT, 'AGENT.md'), agentMd(), 'utf8');
    mkdirSync(agentWorkdir(AGENT), { recursive: true });

    ledger = createLedger({
      dir: join(dir, '.hive', LEDGER_DIR),
      knowsParty: (party) => party === AGENT || party === OVERMIND,
    });

    /*
      The real hook runtime, which writes the host set, the shared container
      set (addressed by the default alias, `host.docker.internal`) and starts
      the receiver — exactly what a launch does before any agent can wake.
    */
    hooks = createHookRuntime({ userDataPath: userData, ledger, sessionMetrics: () => false });
    await hooks.start({
      knowsSession: () => false,
      knowsAgent: (id) => id === AGENT,
      onAgentsList: () => Promise.resolve({ agents: [] }),
      onEvent: () => {},
      onAgentEvent: (event) => {
        agentEvents.push(event);
      },
      onTicketIntent: () => {},
      onPromptName: () => {},
      onCleared: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: () => {},
    });
    await writePluginDir(join(userData, PLUGIN_DIR), '0.0.0-test', NO_SKILLS);

    const credential = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .filter((name) => process.env[name] !== undefined && process.env[name] !== '')
      .flatMap((name) => ['-e', name]);
    execFileSync('docker', [
      'run', '-d', '--name', CNAME,
      '-v', `${join(userData, 'hive')}:${HIVE_DIR}:ro`,
      // The agent's workdir, read-write: the run's cwd inside, and where a
      // `Bash` probe may leave a file.
      '-v', `${agentWorkdir(AGENT)}:${WORKSPACE}`,
      ...credential,
      CLAUDE_IMAGE ?? '',
      'sleep', 'infinity',
    ]);

    agentState = createAgentState({
      path: join(dir, '.hive', LEDGER_DIR, 'agents.json'),
      debounceMs: 1,
    });

    const buildWakeCommand = createWakeCommand({
      agentsRoot,
      workdir: agentWorkdir,
      promptFile: (name) => agentPromptFile(userData, name),
      pluginDir: () => join(userData, PLUGIN_DIR),
      agentSettingsPath: () => hooks.agentSettingsPathFor(),
      // The host stdio file: written by an MCP runtime this suite does not
      // compose, and never read by a container agent — but the builder's
      // host-side precondition wants a path, so it gets one.
      mcpConfig: () => join(userData, 'hive', 'hive.mcp.json'),
      hiveServer: () => null,
      agentMcpFile: (name) => agentMcpConfigFile(userData, name),
      hookEnv: (name) => hooks.envFor(name),
      claudeCommand: () => 'claude',
      subscriptionAuth: () => false,
      state: agentState,
      env: () => process.env,
      newUuid: randomUUID,
      pendingGrants: () => [],
      userDataPath: () => userData,
      hostAlias: () => 'host.docker.internal',
      agentContainerSettingsPath: (config) => hooks.agentContainerSettingsPathFor(config),
    });

    runs = createRunTracker({
      spawn: (file, args, options) => {
        spawns.push({ file, args: [...args] });
        return spawn(file, [...args], options as SpawnOptions) as unknown as ChildLike;
      },
      command: (name, trigger, extra, options) => buildWakeCommand(name, trigger, extra, options),
      parallelFor: () => 1,
      state: agentState,
      appendLedger: (entry) => {
        expect(ledger.append(entry).ok).toBe(true);
      },
      openAsksFor: (name, run) =>
        ledger.read({ from: name }).openAsks.some((ask) => ask.from === name && ask.meta?.['run'] === run),
      hasOpenAsk: (name) => ledger.read({}).openAsks.some((ask) => ask.from === name),
      handoffFor: () => undefined,
      newUuid: randomUUID,
      pushStatus: (name) => {
        if (agentState.read(name).status === 'working') return;
        const settle = settlers.get(name);
        settlers.delete(name);
        settle?.();
      },
      pushLines: (_name, pushed) => lines.push(...pushed),
      now: () => Date.now(),
      newRunId: randomUUID,
      grants: {
        set: (run, owner, grants) => hooks.receiverGrants()?.set(run, owner, grants),
        delete: (run) => hooks.receiverGrants()?.delete(run),
      },
    });
  }, 180_000);

  afterAll(async () => {
    runs.closeAll('app-closed');
    spawnSync('docker', ['rm', '-f', CNAME], { stdio: 'ignore' });
    await hooks.stop();
    if (previousConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'wakes inside the container: hooks on the agent register, a post under its name, no permission card',
    async () => {
      const done = settled(AGENT);
      const start = runs.run(
        AGENT,
        'manual',
        'Call ledger_post once with the body "posted from inside the container by an agent", then reply DONE.',
      );

      expect(start).toMatchObject({ started: true });
      await done;

      expect(spawns[0]?.file).toBe('docker');
      expect(spawns[0]?.args.slice(0, 3)).toEqual(['exec', '--workdir', WORKSPACE]);
      expect(spawns[0]?.args).toContain(CNAME);

      const state = agentState.read(AGENT);
      expect(state.runs.at(-1)?.outcome).toBe('done');
      expect(bodiesFrom(AGENT)).toContain('posted from inside the container by an agent');
      // The hooks crossed, attributed to the agent, through the alias.
      expect(agentEvents.some((event) => event.entityId === AGENT)).toBe(true);
      // The grants crossed: `approve` over HTTP allowed the ledger tool, so
      // no permission ask was ever written.
      expect(
        ledger.read({ from: AGENT }).openAsks.some((ask) => ask.meta?.['kind'] === 'permission'),
      ).toBe(false);
    },
    300_000,
  );

  it(
    'resumes the previous wake: the transcript lives inside the container',
    async () => {
      const done = settled(AGENT);
      runs.run(
        AGENT,
        'manual',
        'Call ledger_post once whose body is exactly "again: " followed by the body you posted in your previous wake, verbatim. Then reply DONE.',
      );
      await done;

      expect(spawns[1]?.args).toContain('--resume');
      expect(sessionUuidOf(spawns[1]?.args ?? [])).toBe(sessionUuidOf(spawns[0]?.args ?? []));
      expect(agentState.read(AGENT).runs.at(-1)?.outcome).toBe('done');
      expect(bodiesFrom(AGENT)).toContain('again: posted from inside the container by an agent');
    },
    300_000,
  );

  it(
    'a kill from the host stops the run inside the container',
    async () => {
      const done = settled(AGENT);
      /*
        `tail -f /dev/null`, not `sleep`: Claude Code refuses a bare `sleep`
        outright — "blocked by the sandbox's standalone-sleep guard", in the
        run log — so a prompt asking for one ends the turn with nothing to
        stop. A tail on /dev/null never exits until it is killed, which is
        the property the case needs.
      */
      runs.run(
        AGENT,
        'manual',
        'Use Bash to run exactly this command: tail -f /dev/null. It never exits on its own; that is expected. Do nothing else.',
      );

      const uuid = sessionUuidOf(spawns.at(-1)?.args ?? []);
      expect(uuid).not.toBe('');

      /*
        Wait for the run to be *inside its tool* before stopping it. Killing a
        process that is still starting proves less than killing one that is
        mid-work: the tool's process is a grandchild of `claude`, and a stop
        that reached only the client, or only `claude`, would leave it
        running. Anchored, or `claude`'s own argv — which carries the prompt
        naming the command — matches, and the poll passes before any tool
        has run.
      */
      const inTool = (): boolean =>
        spawnSync('docker', ['exec', CNAME, 'pgrep', '-f', '^tail -f /dev/null$'], {
          stdio: 'ignore',
        }).status === 0;
      await expect.poll(inTool, { timeout: 120_000, interval: 1_000 }).toBe(true);
      expect(insideAlive(uuid)).toBe(true);

      expect(runs.kill(AGENT)).toBe(true);
      await done;

      expect(agentState.read(AGENT).runs.at(-1)?.outcome).toBe('failed');
      // The measured fact this story exists for: the client alone would not
      // have stopped it. The `pkill -f <uuid>` inside did — and took the
      // tool's process with it.
      await expect.poll(() => insideAlive(uuid), { timeout: 15_000, interval: 500 }).toBe(false);
      await expect.poll(inTool, { timeout: 15_000, interval: 500 }).toBe(false);
      expect(spawns.some((call) => call.args.includes('pkill') && call.args.includes(uuid))).toBe(true);
    },
    300_000,
  );

  it(
    'a stopped container is a failed run naming the runtime\'s reason, and the next wake works again',
    async () => {
      execFileSync('docker', ['stop', CNAME], { stdio: 'ignore' });

      const done = settled(AGENT);
      const before = lines.length;
      runs.run(AGENT, 'manual', 'Reply DONE.');
      await done;

      expect(agentState.read(AGENT).runs.at(-1)?.outcome).toBe('failed');
      expect(lines.slice(before).map((line) => line.text).join('\n')).toContain('is not running');

      execFileSync('docker', ['start', CNAME], { stdio: 'ignore' });
    },
    120_000,
  );
});
