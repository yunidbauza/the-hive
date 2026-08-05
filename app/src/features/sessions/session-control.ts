import type { Effort, Model } from '@/types/entity';

import { isDesktop } from '@config/runtime';
import { reopenChannel } from '@lib/terminal/pty-transport';
import type { SpawnRefusal } from '@shared/session-contract';


/**
 * Verbs that act on a **real** session (story 096).
 *
 * Thin on purpose. Everything interesting — preconditions, project resolution,
 * the login shell, the bootstrap, the process group — lives in the main process,
 * because it is the only side that can be trusted with any of it. What is left
 * here is the one precondition main cannot check: whether there is a main
 * process at all.
 *
 * The wording lives here rather than beside the other three in
 * `session-contract.ts` for a boundary reason, not a stylistic one: `src/**`
 * imports that module **type-only**, so a shared message *function* is not
 * reachable from the renderer. Splitting the table along the process boundary
 * is the honest version — main words the refusals main decides, and this words
 * the one only the renderer can.
 */

/**
 * The one refusal the renderer owns.
 *
 * Distinct from `DESKTOP_ONLY_REASON` in `config/runtime.ts`, which answers a
 * different question ("this control does nothing here") for a different
 * audience. This one is about starting a process.
 */
export const SESSIONS_REQUIRE_DESKTOP = 'sessions require the desktop app';

/** Thrown rather than returned, so a caller cannot ignore it by accident. */
export class SessionRefusedError extends Error {
  readonly refusal: SpawnRefusal;

  constructor(refusal: SpawnRefusal, message: string) {
    super(message);
    this.name = 'SessionRefusedError';
    this.refusal = refusal;
  }
}

export interface RestartRequest {
  entityId: string;
  projectId: string;
  cols: number;
  rows: number;
  /**
   * Carried across the restart (story 109).
   *
   * A restart deliberately drops the session's *task* — the previous generation
   * may already have acted on it — and just as deliberately keeps these. The
   * task is an instruction; the model is what the session **is**, and a row
   * that says Haiku must not come back as something else.
   */
  model?: Model;
  effort?: Effort;
}

/**
 * Kill this session's process and start a fresh one, bootstrapped again.
 *
 * The **only** way a session restarts. Nothing auto-respawns: `PtyTransport`
 * keeps its "already requested" flag set even after an exit precisely so a tab
 * switch or a re-render can never resurrect a finished agent (story 094). That
 * makes restarting something the user chose, which is what it should be — a
 * restart discards a running agent's context.
 */
export async function restartSession(request: RestartRequest): Promise<void> {
  const bridge = window.hive;
  if (!isDesktop() || !bridge) {
    // The one precondition main cannot check, because in the browser build
    // there is no main.
    throw new SessionRefusedError(
      { reason: 'not-desktop' },
      SESSIONS_REQUIRE_DESKTOP,
    );
  }

  await bridge.pty.restart({
    sessionId: request.entityId,
    projectId: request.projectId,
    cols: request.cols,
    rows: request.rows,
    // Spread, not `undefined`: the IPC guard rejects unexpected keys, and an
    // own property set to undefined is still a key after a structured clone.
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
  });

  /**
   * Reopen the renderer's channel for the new generation.
   *
   * `PtyTransport` latches a channel `closed` on exit and never clears it, which
   * is exactly what stops a tab switch resurrecting a finished agent. A restart
   * is the one legitimate way an entity gets a new process, so it is the one
   * place that latch has to be released — otherwise main happily runs the new
   * shell while the renderer drops every chunk it produces, and `sendToSession`
   * keeps refusing with "restart it to send again" after the user just did.
   *
   * After the await, so a restart that failed leaves the channel closed.
   */
  reopenChannel(request.entityId);
}
