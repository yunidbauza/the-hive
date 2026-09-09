import { REMOTE_PROTOCOL_VERSION, type AttachRequest, type ResumePoint } from '@shared/remote-contract';

/**
 * The client half of server mode (HIVE-144).
 *
 * Nothing connects yet — see `electron/remote-host/index.ts` for why the
 * directory exists a story early.
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
