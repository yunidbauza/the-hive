import { REMOTE_PROTOCOL_VERSION, type AttachRefused } from '@shared/remote-contract';

/**
 * The server half of server mode (HIVE-142, HIVE-143).
 *
 * Nothing listens yet. What exists is the directory, its fence and the one
 * refusal every future path funnels through, so that the boundary this module
 * lives behind is proved by `pnpm verify:boundaries` before there is a socket to
 * get it wrong on.
 *
 * The fence: importable by `electron/main/**` only, and never importing `src/**`
 * or the client half. A host that could reach the renderer would be a host that
 * could be made to render, and the two halves must be separable onto two
 * machines by construction rather than by discipline.
 */

/**
 * The refusal sent when a handshake does not agree with this build.
 *
 * Names both versions and which side to update, because the alternative is a
 * user staring at a connection that fails for no stated reason after an update
 * they did not make. Lives here rather than in the contract: the contract says
 * what a refusal *is*, the host decides when to send one.
 */
export function refuseProtocol(clientProtocol: number): AttachRefused {
  /*
    Equal versions are not a mismatch, and the caller has made a mistake rather
    than the client. Worth handling rather than declaring unreachable: this is
    the one refusal every future path funnels through, and the version that a
    two-way comparison produces for the equal case — "client speaks 1, server
    speaks 1. Update the server." — is worse than useless to whoever reads it at
    two in the morning.
  */
  if (clientProtocol === REMOTE_PROTOCOL_VERSION) {
    return {
      kind: 'attach-refused',
      code: 'protocol-mismatch',
      protocol: REMOTE_PROTOCOL_VERSION,
      message:
        `Protocol ${String(REMOTE_PROTOCOL_VERSION)} matches on both sides; ` +
        'this handshake was refused for another reason.',
    };
  }

  const side = clientProtocol < REMOTE_PROTOCOL_VERSION ? 'client' : 'server';
  return {
    kind: 'attach-refused',
    code: 'protocol-mismatch',
    protocol: REMOTE_PROTOCOL_VERSION,
    message:
      `Protocol mismatch: client speaks ${String(clientProtocol)}, ` +
      `server speaks ${String(REMOTE_PROTOCOL_VERSION)}. Update the ${side}.`,
  };
}
