import { REMOTE_PROTOCOL_VERSION, type AttachRequest, type ResumePoint } from '@shared/remote-contract';

/**
 * The client half of server mode (HIVE-144).
 *
 * The connection itself lives in `./socket.ts` — `connectRemote`,
 * `PlaintextRefusedError` and the rest are exported from there, and callers
 * import that module directly rather than a barrel here. Deliberately not
 * re-exported: `socket.ts` needs {@link attachRequest}, so a barrel in this
 * file would be `index -> socket -> index`, which `import/no-cycle` fails and
 * which would be a real cycle rather than a lint technicality. The frame this
 * file builds is the one thing the socket cannot own, because the difference
 * between an absent and an empty `resumeFrom` is a contract decision that was
 * made here first (HIVE-141) and is asserted by this module's own tests.
 *
 * The fence: importable by the client's own main process only, and never
 * importing `src/**` or the host half. The renderer reaching a socket client
 * directly would defeat the whole reason the cut goes below the preload bridge.
 */

/**
 * The first frame this build would send.
 *
 * `resumeFrom` is omitted rather than empty on a first attach: an empty map and
 * an absent one mean different things to a server deciding whether to replay,
 * and the difference is easier to keep straight in the type than in a comment.
 */
export function attachRequest(
  deviceId: string,
  token: string,
  resumeFrom?: Readonly<Record<string, ResumePoint>>,
): AttachRequest {
  return {
    kind: 'attach',
    protocol: REMOTE_PROTOCOL_VERSION,
    deviceId,
    token,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  };
}
