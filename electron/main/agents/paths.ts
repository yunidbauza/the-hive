import { dirname, join } from 'node:path';

import { AGENTS_DIR } from '@shared/agent-contract';

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
