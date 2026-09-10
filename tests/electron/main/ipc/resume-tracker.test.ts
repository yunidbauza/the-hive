// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { attachRequest } from '../../../../electron/remote-client/index';
import { frameBytes } from '../../../../electron/remote-client/socket';
import { ATTACH_FRAME_MAX_BYTES } from '../../../../electron/shared/remote-contract';
import {
  composeResumeFrom,
  createResumeTracker,
} from '../../../../electron/main/ipc/resume-tracker';

/**
 * What an attached client remembers so it can resume (HIVE-150).
 *
 * HIVE-144 built `{gen, seq}` resume points and bumped the protocol for them,
 * but nothing on the client ever populated one — `router.ts` dialled without a
 * `resumeFrom` and tracked no sequence. This is the bookkeeping that makes a
 * reconnect cheap rather than a full re-hydrate.
 *
 * Two signals feed it, from opposite directions, and both are needed:
 * `record` from inbound `pty:data`, and `markWatched` from outbound `pty:ack`.
 * The second is what HIVE-145 established as the honest test of "the user is
 * actually looking at this session" — a surface only ever acks a session whose
 * terminal it has mounted.
 */
describe('createResumeTracker', () => {
  it('answers the point a watched session last reached', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 3, 41);

    expect(tracker.points()).toEqual([{ sessionId: 's1', point: { gen: 3, seq: 41 } }]);
  });

  it('advances the sequence within a generation', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 3, 41);
    tracker.record('s1', 3, 42);

    expect(tracker.points()[0].point).toEqual({ gen: 3, seq: 42 });
  });

  it('replaces the point on a new generation rather than advancing it', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 1, 40);
    // A restart. `emptyChannel()` resets seq to 0 for the new pty session, so
    // generation 2's batch 1 arrives numbered below generation 1's last.
    tracker.record('s1', 2, 1);

    /*
      Keeping `seq: 40` here would be the HIVE-144 defect arriving from this
      side of the wire: the client would ask to resume generation 2 from a
      sequence that generation never reached, and the server would replay from
      a point that means nothing — silently swallowing the restart and
      everything the new process produced before it.
    */
    expect(tracker.points()[0].point).toEqual({ gen: 2, seq: 1 });
  });

  it('ignores a frame from a generation it has already moved past', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 2, 5);
    // A straggler from the old process, delivered after the restart.
    tracker.record('s1', 1, 99);

    expect(tracker.points()[0].point).toEqual({ gen: 2, seq: 5 });
  });

  it('never moves a sequence backwards within a generation', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 2, 9);
    tracker.record('s1', 2, 4);

    expect(tracker.points()[0].point).toEqual({ gen: 2, seq: 9 });
  });

  it('leaves out a session no terminal has mounted', () => {
    const tracker = createResumeTracker();
    tracker.record('unwatched', 1, 7);
    tracker.markWatched('watched');
    tracker.record('watched', 1, 7);

    /*
      A session with no mounted terminal has no scrollback on this client to
      preserve, so it has nothing to resume — and the attach frame it would
      otherwise occupy is bounded at 8 KiB.
    */
    expect(tracker.points().map((p) => p.sessionId)).toEqual(['watched']);
  });

  it('orders the most recently active first', () => {
    const tracker = createResumeTracker();
    for (const id of ['a', 'b', 'c']) tracker.markWatched(id);
    tracker.record('a', 1, 1);
    tracker.record('c', 1, 1);
    tracker.record('b', 1, 1);

    // The order eviction reads when the frame will not hold every point.
    expect(tracker.points().map((p) => p.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('forgets a session outright', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 1, 1);
    tracker.forget('s1');

    expect(tracker.points()).toEqual([]);
  });

  it('records before a mount and answers once the mount acks', () => {
    const tracker = createResumeTracker();
    // Data can arrive before this surface has acked anything — the terminal
    // mounts lazily, and the first batch is what it mounts to show.
    tracker.record('s1', 1, 12);
    expect(tracker.points()).toEqual([]);

    tracker.markWatched('s1');
    expect(tracker.points()).toEqual([{ sessionId: 's1', point: { gen: 1, seq: 12 } }]);
  });
});

/** A tracker holding `count` watched sessions, ids shaped like the real ones. */
function trackerWith(count: number) {
  const tracker = createResumeTracker();
  for (let i = 0; i < count; i += 1) {
    const id = `sess-${String(i).padStart(4, '0')}-${'a1b2c3d4'}`;
    tracker.markWatched(id);
    tracker.record(id, 2, 1_000 + i);
  }
  return tracker;
}

/**
 * Fitting the resume points into the attach frame (HIVE-150).
 *
 * `ATTACH_FRAME_MAX_BYTES` is 8 KiB and the client **throws** rather than
 * truncating when a frame exceeds it — `AttachFrameTooLargeError`, added by
 * HIVE-144 for diagnosability at a time when nothing populated `resumeFrom` at
 * all, so it could never actually fire. Populating it in production is what
 * makes that error reachable for the first time, and a client with a large
 * fleet would find itself unable to reattach with no obvious cause.
 *
 * So composition is bounded here, at the point the map is built, rather than
 * discovered at the point it is refused.
 */
describe('composeResumeFrom', () => {
  it('carries the points of watched sessions', () => {
    const tracker = createResumeTracker();
    tracker.markWatched('s1');
    tracker.record('s1', 4, 7);

    expect(composeResumeFrom(tracker)).toEqual({ s1: { gen: 4, seq: 7 } });
  });

  it('is undefined when nothing is worth resuming', () => {
    /*
      Absent rather than empty, which `attachRequest` is explicit about: an
      empty map and an absent one mean different things to a server deciding
      whether to replay.
    */
    expect(composeResumeFrom(createResumeTracker())).toBeUndefined();
  });

  it('keeps the real attach frame under the ceiling with a large fleet', () => {
    const composed = composeResumeFrom(trackerWith(500));
    const frame = JSON.stringify(attachRequest('d_9f2c', 's3cret'.repeat(8), composed));

    /*
      Measured against the frame the client will actually send, built by the
      same `attachRequest` and weighed by the same `frameBytes`, rather than
      against an estimate of forty bytes per entry. An estimate is a belief
      about the encoding; this is the encoding.
    */
    expect(frameBytes(frame)).toBeLessThanOrEqual(ATTACH_FRAME_MAX_BYTES);
  });

  it('evicts the least recently active first', () => {
    const tracker = trackerWith(500);
    // The most recently active session in `trackerWith` is the last one built.
    const composed = composeResumeFrom(tracker) ?? {};

    const kept = Object.keys(composed);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(500);
    /*
      The sessions the user is looking at right now are the ones whose
      scrollback is worth resuming. An evicted session takes a gap notice on
      its next batch, which the terminal already renders.
    */
    expect(kept).toContain('sess-0499-a1b2c3d4');
    expect(kept).not.toContain('sess-0000-a1b2c3d4');
  });

  it('is accepted by the client that weighs it, at any fleet size', () => {
    /*
      The property the whole task exists for, stated as one loop: whatever the
      tracker holds, the composed frame is one `connectRemote` will send rather
      than refuse. Sizes chosen around the boundary the eviction defends.
    */
    for (const size of [0, 1, 50, 200, 500, 2_000]) {
      const composed = composeResumeFrom(trackerWith(size));
      const frame = JSON.stringify(attachRequest('d_9f2c', 's3cret'.repeat(8), composed));
      expect(frameBytes(frame), `a fleet of ${String(size)} overflowed`).toBeLessThanOrEqual(
        ATTACH_FRAME_MAX_BYTES,
      );
    }
  });
});
