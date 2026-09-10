import { ATTACH_FRAME_MAX_BYTES, type ResumePoint } from '@shared/remote-contract';

import { attachRequest } from '../../remote-client/index';
import { frameBytes } from '../../remote-client/socket';

/** A session's resume point, with the id it belongs to. */
export interface TrackedPoint {
  sessionId: string;
  point: ResumePoint;
}

/**
 * What an attached client remembers so a reconnect can resume rather than
 * re-hydrate (HIVE-150).
 *
 * HIVE-144 built the `{gen, seq}` resume point and bumped
 * `REMOTE_PROTOCOL_VERSION` for it, and HIVE-143 built the server side that
 * answers `replay` or `gap` against one. Neither ever ran in production,
 * because nothing on this side tracked a sequence: `router.ts` dialled without
 * a `resumeFrom` at all. This is the missing half.
 *
 * **It lives in main rather than in `electron/remote-client/`** because it needs
 * two signals and only one of them reaches the client. `record` comes from
 * inbound `pty:data`, which the socket does see; `markWatched` comes from
 * outbound `pty:ack`, which passes through the proxy's notify path and never
 * enters the socket module at all. Keeping it here also keeps `remote-client`
 * dumb — `connectRemote` still receives plain `resumeFrom` data and knows
 * nothing about how it was built, which the import fences require in any case.
 */
export interface ResumeTracker {
  /** From an inbound `pty:data` frame. */
  record(sessionId: string, gen: number, seq: number): void;
  /**
   * From an outbound `pty:ack`.
   *
   * HIVE-145's ruling is what makes this the right predicate: a surface only
   * ever acks a session whose terminal it has mounted, so an ack is the honest
   * signal that this client is actually rendering the session rather than
   * merely attached to the machine running it.
   */
  markWatched(sessionId: string): void;
  forget(sessionId: string): void;
  /** Watched sessions only, most recently active first. */
  points(): TrackedPoint[];
}

interface Entry {
  gen: number;
  seq: number;
  watched: boolean;
  /** A counter, not a clock — see {@link createResumeTracker}. */
  rank: number;
}

export function createResumeTracker(): ResumeTracker {
  const entries = new Map<string, Entry>();
  /*
    Recency as a monotonic counter rather than `Date.now()`.

    Two reasons. A clock ties: several sessions can record inside one
    millisecond, and the order eviction reads would then be arbitrary among
    them. And a counter owes nothing to fake timers, so a test that installs
    them for the reconnect schedule does not silently freeze this ordering too.
  */
  let clock = 0;

  const touch = (entry: Entry): void => {
    clock += 1;
    entry.rank = clock;
  };

  return {
    record(sessionId, gen, seq) {
      const existing = entries.get(sessionId);
      if (existing === undefined) {
        clock += 1;
        entries.set(sessionId, { gen, seq, watched: false, rank: clock });
        return;
      }

      /*
        A straggler from a process that has already been replaced. Delivered
        after the restart because the fan-out and the restart race, and taking
        it would walk the point backwards into a generation that is gone.
      */
      if (gen < existing.gen) return;

      if (gen > existing.gen) {
        /*
          A restart, and the point is **replaced** rather than advanced.
          `emptyChannel()` resets `seq` to 0 for the new pty session, so the
          new generation's early batches are numbered below the old
          generation's last. Keeping the higher `seq` would be HIVE-144's
          defect arriving from this side of the wire: the client would ask to
          resume the new generation from a sequence it never reached, and the
          server would answer from a point that means nothing — swallowing the
          restart and everything the new process produced before it.
        */
        existing.gen = gen;
        existing.seq = seq;
        touch(existing);
        return;
      }

      // Same generation: monotonic, so an out-of-order frame cannot rewind it.
      if (seq > existing.seq) existing.seq = seq;
      touch(existing);
    },

    markWatched(sessionId) {
      const existing = entries.get(sessionId);
      if (existing === undefined) {
        /*
          An ack can precede any data this tracker saw — the surface may be
          re-acking a session whose earlier batches arrived before it mounted.
          Seeded at generation 0, which every real generation is above, so the
          first real frame replaces it rather than being mistaken for a
          straggler.
        */
        clock += 1;
        entries.set(sessionId, { gen: 0, seq: 0, watched: true, rank: clock });
        return;
      }
      existing.watched = true;
      touch(existing);
    },

    forget(sessionId) {
      entries.delete(sessionId);
    },

    points() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.watched)
        .sort(([, a], [, b]) => b.rank - a.rank)
        .map(([sessionId, entry]) => ({
          sessionId,
          point: { gen: entry.gen, seq: entry.seq },
        }));
    },
  };
}

/**
 * The longest `deviceId` and token this composer leaves room for, each.
 *
 * The frame it measures carries a placeholder of this length rather than the
 * real credential, because composition happens before a dial and the credential
 * is the dialler's business.
 *
 * 512 against a real pairing's 16 base32 characters of token and `d_` plus four
 * hex of device id (`electron/main/server/devices.ts`) — so about twenty-two
 * bytes are being budgeted a thousand. That is deliberately lopsided. The cost
 * is roughly twenty-five fewer resume points in a fleet large enough to hit the
 * ceiling at all; the alternative is a composer whose guarantee holds only
 * while credentials stay short, and this one exists precisely so that
 * `AttachFrameTooLargeError` cannot fire in production.
 */
const CREDENTIAL_HEADROOM = 512;

/**
 * The resume points that fit in one attach frame, most recently active first
 * (HIVE-150).
 *
 * Two bounds, and they do different jobs.
 *
 * **Watched only** — enforced by {@link ResumeTracker.points} — is the one that
 * makes this small in practice. HIVE-145's ruling that being attached is not
 * the same as watching applies exactly: a session with no mounted terminal has
 * no scrollback on this client to preserve, so resuming it would spend the
 * frame on output nothing is going to render.
 *
 * **The byte ceiling** is the one that makes it safe. `ATTACH_FRAME_MAX_BYTES`
 * is 8 KiB and the client throws `AttachFrameTooLargeError` rather than
 * truncating, so without this a user with a large fleet would simply be unable
 * to reattach. Evicting the least recently active is the honest trade: those
 * sessions take a `gap` notice on their next batch, which the terminal already
 * knows how to render, rather than the whole reconnect failing.
 *
 * Returns `undefined`, never `{}`, for the reason `attachRequest`'s own doc
 * comment gives: an absent map and an empty one mean different things to a
 * server deciding whether to replay.
 */
export function composeResumeFrom(
  tracker: ResumeTracker,
  budgetBytes: number = ATTACH_FRAME_MAX_BYTES,
): Readonly<Record<string, ResumePoint>> | undefined {
  const candidates = tracker.points();
  if (candidates.length === 0) return undefined;

  const placeholder = 'x'.repeat(CREDENTIAL_HEADROOM);
  /*
    Null-prototype, because the keys are session ids the *server* chose. On a
    plain object literal `fitted['__proto__'] = point` sets the prototype rather
    than an own key, and the `delete` that backs out an over-budget entry then
    cannot undo it — leaving a mutated object that `JSON.stringify` renders
    without the key it thinks it holds.
  */
  const fitted: Record<string, ResumePoint> = Object.create(null) as Record<string, ResumePoint>;
  let kept = 0;

  for (const { sessionId, point } of candidates) {
    fitted[sessionId] = point;
    /*
      Weighed against the frame that will actually be sent, built by the same
      `attachRequest` and measured by the same `frameBytes` the client uses to
      refuse one. An arithmetic estimate here would be a second opinion about
      the encoding, and the first time the two disagreed the client would throw
      on a map this function had just declared safe.
    */
    const weight = frameBytes(
      JSON.stringify(attachRequest(placeholder, placeholder, fitted)),
    );
    if (weight > budgetBytes) {
      delete fitted[sessionId];
      break;
    }
    kept += 1;
  }

  return kept === 0 ? undefined : fitted;
}
