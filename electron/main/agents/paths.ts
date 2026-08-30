import { dirname, join } from 'node:path';

import { AGENTS_DIR } from '@shared/agent-contract';
import { LEDGER_DIR } from '@shared/ledger-contract';

import { configPath } from '../config/paths';

/**
 * Where agent definitions live (HIVE-114).
 *
 * Beside `config.json`, `skills/` and `ledger/` under `~/.hive` — not inside
 * Electron's userData. `skills/paths.ts` and `ledger/` both give the reasoning
 * and this follows it: a definition is a document the person is invited to
 * open, `grep` and back up, not an app-private artifact.
 *
 * Derived from `configPath()` rather than `homedir()` for the reason that file
 * states: `configPath()` honours `HIVE_CONFIG_PATH`, so a test that relocates
 * the config relocates the agents with it. Reaching for `homedir()` here would
 * have every e2e run write into the developer's own `~/.hive` — and this
 * story's e2e spec *creates an agent*, so that would not stay theoretical.
 *
 * Read per call rather than captured, so the first spec to import this module
 * does not decide the path for all of them.
 */
export const agentsRoot = (): string => join(dirname(configPath()), AGENTS_DIR);

/**
 * `~/.hive/ledger/agents.json` — main's own bookkeeping about the runs it has
 * made (HIVE-115).
 *
 * Inside `ledger/` rather than beside it, because the ledger directory is
 * already the place where "what happened" is written and this is the derived
 * index over the part of it main owns. It is derived from `configPath()` for
 * the same reason {@link agentsRoot} is.
 */
export const agentStateFile = (): string =>
  join(dirname(configPath()), LEDGER_DIR, 'agents.json');

/**
 * `~/.hive/work/<name>` — an agent's working directory, created on demand.
 *
 * **Deliberately not** `~/.hive/agents/<name>`. `registry.ts` watches that tree
 * with `{ recursive: true }`, so every scratch file an agent wrote would fire
 * the debounced watcher, re-parse every definition on the machine, and push
 * `agents:changed` at the renderer. A working directory that invalidates the
 * list of agents each time it is written to is not a working directory.
 *
 * It is a cwd, not a sandbox: it bounds where the file tools start, and bounds
 * Bash not at all. Confinement is HIVE-119's `--permission-prompt-tool`.
 */
export const agentWorkdir = (name: string): string =>
  join(dirname(configPath()), 'work', name);

/**
 * `<userData>/hive/agents/<name>.system.md` — the generated system prompt.
 *
 * A path *segment*, like `PLUGIN_DIR` and `MCP_CONFIG_FILE`, because the
 * absolute form needs `app.getPath` and keeping the constant relative is what
 * lets this module's callers be tested under plain Node.
 *
 * In `userData` rather than `~/.hive`, and the line is the one `skills/paths.ts`
 * draws: `~/.hive` holds what the *user* writes, `userData` holds what the app
 * regenerates. This file is rewritten from the preamble and the definition body
 * on every single wake, so that an app update reaches every agent without
 * anyone editing anything.
 */
export const AGENT_PROMPT_DIR = join('hive', AGENTS_DIR);

/** The generated prompt for one agent, under {@link AGENT_PROMPT_DIR}. */
export const agentPromptFile = (userDataPath: string, name: string): string =>
  join(userDataPath, AGENT_PROMPT_DIR, `${name}.system.md`);
