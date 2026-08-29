// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  HOOK_MAX_BODY_BYTES,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '../../../../electron/shared/hook-contract';
import {
  LEDGER_BODY_MAX,
  LEDGER_POST_PATH,
  LEDGER_READ_PATH,
  type LedgerSnapshot,
} from '../../../../electron/shared/ledger-contract';
import {
  METRICS_PATH,
  type SessionMetrics,
} from '../../../../electron/shared/metrics-contract';
import { createLedger, type Ledger } from '../../../../electron/main/ledger';
import { createReceiver, type Receiver } from '../../../../electron/main/hooks/receiver';

/**
 * Every call site below that is not exercising the ledger routes still needs
 * these two — they are required options — but has no reason to care what they
 * answer. A refusal that names itself keeps a test that *does* hit one of them
 * by accident loud rather than silently green.
 */
const noLedger = {
  onLedgerRead: (): LedgerSnapshot => ({ entries: [], openAsks: [], claims: {} }),
  onLedgerPost: () => ({ ok: false as const, status: 503, reason: 'not exercised by this test' }),
};

/**
 * The receiver is exercised over a real loopback socket rather than by calling
 * its handler directly.
 *
 * The properties that matter here are HTTP-level — the method and path it
 * refuses, the header it authenticates on, the body size it declines to buffer —
 * and a direct call would assert the parts that were never in doubt while
 * skipping the ones that were.
 */
describe('hook receiver', () => {
  let receiver: Receiver;
  let events: HookStatusEvent[];
  let intents: HookTicketIntentEvent[];
  let cleared: string[];
  let dones: string[];
  let readies: string[];
  let url: string;
  let dir: string;
  let ledger: Ledger;

  beforeEach(async () => {
    events = [];
    intents = [];
    cleared = [];
    dones = [];
    readies = [];
    dir = mkdtempSync(join(tmpdir(), 'hive-receiver-ledger-'));
    ledger = createLedger({ dir, knowsParty: (id) => id !== 'sess-gone' });
    receiver = createReceiver({
      onCleared: (entityId) => cleared.push(entityId),
      onEvent: (event) => events.push(event),
      onTicketIntent: (event) => intents.push(event),
      onDone: (entityId) => dones.push(entityId),
      onReady: (entityId) => readies.push(entityId),
      // Every session exists except the one explicitly named as gone.
      knowsSession: (entityId) => entityId !== 'sess-gone',
      onMetrics: () => {},
      // The wiring `hooks/index.ts` uses: the query goes down untouched and
      // `visibleTo` inside the receiver is the only identity filter.
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
    });
    const started = await receiver.start();
    expect(started).not.toBeNull();
    url = started as string;
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = {
      [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
      [HOOK_HEADER_SESSION]: 'sess-01',
    },
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('binds loopback only', () => {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  /**
   * The `/done` route (HIVE-93).
   *
   * Every test here is about **authority**, because that is all this route has
   * to get right: the request carries no payload, so the only questions are
   * whether it is from a session this app has and whether it holds the launch
   * token. What the app does afterwards — write `/exit`, record `done` — is
   * `sessions/index.test.ts`.
   */
  /**
   * The `/ready` route (HIVE-101).
   *
   * `/done`'s twin, and tested the same way for the same reason: the request
   * carries no payload, so authority is the whole of what this route has to get
   * right. What the app does afterwards — uncover the terminal, stop the
   * timeout — is the renderer's, and is tested there.
   */
  describe('/ready', () => {
    const ready = (
      headers: Record<string, string> = {
        [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
        [HOOK_HEADER_SESSION]: 'sess-01',
      },
      init: RequestInit = {},
    ) =>
      fetch(receiver.readyUrl as string, {
        method: 'POST',
        headers,
        ...init,
      });

    it('shares the socket with the hook route', () => {
      const origin = (raw: string) => new URL(raw).origin;
      expect(origin(receiver.readyUrl as string)).toBe(origin(url));
      expect(new URL(receiver.readyUrl as string).pathname).toBe('/ready');
    });

    it('reports the session whose Claude is up', async () => {
      const response = await ready();

      expect(response.status).toBe(204);
      expect(readies).toEqual(['sess-01']);
    });

    /**
     * `/clear` starts a second Claude session inside the same pty and produces
     * a second `SessionStart`. The receiver forwards both rather than
     * de-duplicating: it holds no per-session state, and the renderer's action
     * is idempotent precisely so that it does not have to.
     */
    it('reports every arrival, because a clear produces another one', async () => {
      await ready();
      await ready();

      expect(readies).toEqual(['sess-01', 'sess-01']);
    });

    it('refuses a request without the launch token', async () => {
      const response = await ready({
        [HOOK_HEADER_TOKEN]: 'not-the-token',
        [HOOK_HEADER_SESSION]: 'sess-01',
      });

      expect(response.status).toBe(403);
      expect(readies).toEqual([]);
    });

    it('refuses a session the app does not have', async () => {
      const response = await ready({
        [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'),
        [HOOK_HEADER_SESSION]: 'sess-gone',
      });

      expect(response.status).toBe(404);
      expect(readies).toEqual([]);
    });

    it('refuses a request that names no session at all', async () => {
      const response = await ready({ [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01') });

      expect(response.status).toBe(400);
      expect(readies).toEqual([]);
    });

    it('is POST-only', async () => {
      const response = await fetch(receiver.readyUrl as string, { method: 'GET' });

      expect(response.status).toBe(404);
      expect(readies).toEqual([]);
    });

    /**
     * The hook that calls this runs inside a starting session, and a red line
     * in the user's terminal on the first frame is exactly what this feature
     * exists to prevent. So a body nothing reads is drained, never refused.
     */
    it('drains a body rather than refusing one', async () => {
      const response = await ready(
        {
          [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
          [HOOK_HEADER_SESSION]: 'sess-01',
        },
        { body: 'x'.repeat(4096) },
      );

      expect(response.status).toBe(204);
      expect(readies).toEqual(['sess-01']);
    });
  });

  describe('/done', () => {
    const done = (
      headers: Record<string, string> = {
        [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
        [HOOK_HEADER_SESSION]: 'sess-01',
      },
      init: RequestInit = {},
    ) =>
      fetch(receiver.doneUrl as string, {
        method: 'POST',
        headers,
        ...init,
      });

    it('shares the socket with the hook route', () => {
      const origin = (raw: string) => new URL(raw).origin;
      expect(origin(receiver.doneUrl as string)).toBe(origin(url));
      expect(new URL(receiver.doneUrl as string).pathname).toBe('/done');
    });

    it('reports the session that declared itself finished', async () => {
      const response = await done();

      expect(response.status).toBe(204);
      expect(dones).toEqual(['sess-01']);
    });

    it('refuses a request without the launch token', async () => {
      const response = await done({
        [HOOK_HEADER_TOKEN]: 'not-the-token',
        [HOOK_HEADER_SESSION]: 'sess-01',
      });

      expect(response.status).toBe(403);
      expect(dones).toEqual([]);
    });

    it('refuses a session the app does not have', async () => {
      const response = await done({
        [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'),
        [HOOK_HEADER_SESSION]: 'sess-gone',
      });

      expect(response.status).toBe(404);
      expect(dones).toEqual([]);
    });

    it('refuses a request that names no session at all', async () => {
      const response = await done({ [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01') });

      expect(response.status).toBe(400);
      expect(dones).toEqual([]);
    });

    it('is POST-only', async () => {
      const response = await fetch(receiver.doneUrl as string, { method: 'GET' });

      expect(response.status).toBe(404);
      expect(dones).toEqual([]);
    });

    it('drains a body rather than refusing one', async () => {
      /*
        The route expects none, so its cap is zero — but a caller that sends
        one anyway is answered normally. A red line in the user's terminal is
        never worth a payload nothing reads.
      */
      const response = await done(
        {
          [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
          [HOOK_HEADER_SESSION]: 'sess-01',
          'content-type': 'application/json',
        },
        { body: JSON.stringify({ summary: 'ignored entirely' }) },
      );

      expect(response.status).toBe(204);
      expect(dones).toEqual(['sess-01']);
    });
  });

  describe('the ledger routes', () => {
    // `url` is the `/hook` route's full address, not the socket's origin.
    const origin = () => new URL(url).origin;

    const post = async (path: string, body: unknown, headers: Record<string, string>) =>
      fetch(`${origin()}${path}`, {
        method: 'POST',
        // The default token is derived for whatever session the caller names —
        // never a fixed value — so a test that claims a different session id
        // still presents that session's *own* valid token unless it explicitly
        // overrides `HOOK_HEADER_TOKEN` itself.
        headers: {
          [HOOK_HEADER_TOKEN]: receiver.tokenFor(headers[HOOK_HEADER_SESSION] ?? ''),
          ...headers,
        },
        body: JSON.stringify(body),
      });

    it('refuses a post with the wrong token', async () => {
      const response = await fetch(`${origin()}${LEDGER_POST_PATH}`, {
        method: 'POST',
        headers: { [HOOK_HEADER_TOKEN]: 'wrong', [HOOK_HEADER_SESSION]: 'sess-a' },
        body: JSON.stringify({ kind: 'post', body: 'hi' }),
      });

      expect(response.status).toBe(403);
    });

    it('refuses a post from a session the app does not have', async () => {
      const response = await post(
        LEDGER_POST_PATH,
        { kind: 'post', body: 'hi' },
        { [HOOK_HEADER_SESSION]: 'sess-gone' },
      );

      expect(response.status).toBe(404);
    });

    it('stores the header session as `from`, ignoring the body', async () => {
      const response = await post(
        LEDGER_POST_PATH,
        { from: 'someone-else', kind: 'post', body: 'hi' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      expect(response.status).toBe(200);

      const read = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-a' });
      // Every ledger reply carries a body, unlike the four routes that predate
      // HIVE-111 — a caller reading it as JSON is relying on this header.
      expect(read.headers.get('content-type')).toBe('application/json');
      const snapshot = (await read.json()) as LedgerSnapshot;

      expect(snapshot.entries).toHaveLength(1);
      expect(snapshot.entries[0].from).toBe('sess-a');
    });

    /**
     * This is the ledger's own body cap (`LEDGER_BODY_MAX`, 16 KB), enforced by
     * the write layer `onLedgerPost` calls into — not the transport cap the
     * route table buffers against. The body posted here (16385 bytes) is well
     * under `HOOK_MAX_BODY_BYTES`, so `truncated` is false and this exercises
     * the pass-through of `LedgerResult`'s refusal, not `handleLedgerPost`'s
     * own `truncated` branch. See the next test for that.
     */
    it('passes a 413 from the write layer through, reason and all', async () => {
      const response = await post(
        LEDGER_POST_PATH,
        { kind: 'post', body: 'x'.repeat(LEDGER_BODY_MAX + 1) },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );

      expect(response.status).toBe(413);
      expect((await response.json()) as { reason: string }).toMatchObject({
        reason: expect.stringContaining(String(LEDGER_BODY_MAX)),
      });
    });

    /**
     * `handleLedgerPost`'s own branch: a body past the *transport* cap
     * (`HOOK_MAX_BODY_BYTES`) is refused rather than drained, unlike every
     * other route on this receiver — see the comment at its `truncated` check.
     * This never reaches `JSON.parse` or the write layer at all.
     */
    it('refuses, rather than drains, a body over the transport cap', async () => {
      const response = await post(
        LEDGER_POST_PATH,
        { kind: 'post', body: 'x'.repeat(HOOK_MAX_BODY_BYTES + 1) },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );

      expect(response.status).toBe(413);
      expect((await response.json()) as { reason: string }).toMatchObject({
        reason: expect.stringContaining(String(HOOK_MAX_BODY_BYTES)),
      });
    });

    it('answers 400 with a reason when an answer names no open thread', async () => {
      const response = await post(
        LEDGER_POST_PATH,
        { kind: 'answer', thread: 'a99', body: 'yes' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );

      expect(response.status).toBe(400);
      expect((await response.json()) as { reason: string }).toMatchObject({
        reason: expect.stringContaining('a99'),
      });
    });

    it('answers 400 for a body that is not JSON', async () => {
      const response = await fetch(`${origin()}${LEDGER_POST_PATH}`, {
        method: 'POST',
        headers: { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-a'), [HOOK_HEADER_SESSION]: 'sess-a' },
        body: 'not json',
      });

      expect(response.status).toBe(400);
    });

    it('refuses GET on a ledger route', async () => {
      const response = await fetch(`${origin()}${LEDGER_READ_PATH}`, {
        method: 'GET',
        headers: { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-a'), [HOOK_HEADER_SESSION]: 'sess-a' },
      });

      expect(response.status).toBe(404);
    });

    it('shows a third party only the broadcast, not what was addressed elsewhere', async () => {
      await post(LEDGER_POST_PATH, { to: 'sess-b', kind: 'post', body: 'private' }, { [HOOK_HEADER_SESSION]: 'sess-a' });
      await post(LEDGER_POST_PATH, { kind: 'post', body: 'everyone' }, { [HOOK_HEADER_SESSION]: 'sess-a' });

      const read = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-c' });
      const snapshot = (await read.json()) as LedgerSnapshot;

      expect(snapshot.entries.map((entry) => entry.body)).toEqual(['everyone']);
    });

    /**
     * The write path is header-locked — `from` is always the caller, never the
     * body. The read path must be too: naming another party in the query's
     * `to` field must never widen what a caller is shown beyond what it is
     * already entitled to see. `handleLedgerRead` enforces this itself, after
     * `onLedgerRead` returns, precisely so it holds no matter how the next
     * task wires the ledger in.
     */
    it('does not let a caller widen what it sees by naming another party in `to`', async () => {
      await post(
        LEDGER_POST_PATH,
        { to: 'sess-b', kind: 'post', body: 'for b only' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );

      const asA = await post(
        LEDGER_READ_PATH,
        { to: 'sess-a' },
        { [HOOK_HEADER_SESSION]: 'sess-c' },
      );
      const asB = await post(
        LEDGER_READ_PATH,
        { to: 'sess-b' },
        { [HOOK_HEADER_SESSION]: 'sess-c' },
      );

      expect(((await asA.json()) as LedgerSnapshot).entries).toEqual([]);
      expect(((await asB.json()) as LedgerSnapshot).entries).toEqual([]);

      // The addressee itself still sees it — the filter narrows, not blocks.
      const asBItself = await post(
        LEDGER_READ_PATH,
        {},
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );
      expect(((await asBItself.json()) as LedgerSnapshot).entries).toHaveLength(1);
    });

    /**
     * The other half of `visibleTo` (HIVE-111 final review, finding 2).
     *
     * An ask is written `from: sess-a, to: overmind`, so any `to: caller`
     * default upstream — which is what the wiring used to apply — hides a
     * session's own questions from it and leaves no query at all by which it
     * could read its own correspondence back. The `from === caller` branch is
     * what makes that possible, and it is only reachable once the query
     * reaches `ledger.read` unmodified.
     */
    it('lets a session read back its own ask, addressed though it is to the overmind', async () => {
      const written = await post(
        LEDGER_POST_PATH,
        { to: 'overmind', kind: 'ask', body: 'may I merge?' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      expect(written.status).toBe(200);

      const asA = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-a' });
      const mine = (await asA.json()) as LedgerSnapshot;
      expect(mine.entries.map((entry) => entry.body)).toEqual(['may I merge?']);
      expect(mine.openAsks.map((ask) => ask.body)).toEqual(['may I merge?']);

      // And a party to neither end of it still sees nothing.
      const asC = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-c' });
      expect(((await asC.json()) as LedgerSnapshot).entries).toEqual([]);
    });

    /**
     * The ask-openness rule on the *HTTP* path (HIVE-111 final review,
     * finding 1).
     *
     * `Ledger.answer` is reachable from IPC alone; every out-of-process
     * party — the MCP host of HIVE-112 included — arrives at `Ledger.append`
     * through this route. Since `openAsks` closes an ask on any answer naming
     * it, a second answer accepted here would silently retire a question.
     */
    it('refuses an answer to an already-closed thread, and appends nothing', async () => {
      // Addressed to `sess-b`, which answers it: only a party to a thread may
      // close it, and this spec is about the openness rule, not that one.
      const asked = await post(
        LEDGER_POST_PATH,
        { to: 'sess-b', kind: 'ask', body: 'ship it?' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      const { id: thread } = (await asked.json()) as { id: string };

      const first = await post(
        LEDGER_POST_PATH,
        { kind: 'answer', thread, body: 'yes' },
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );
      expect(first.status).toBe(200);

      const second = await post(
        LEDGER_POST_PATH,
        { kind: 'answer', thread, body: 'no, wait' },
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );
      expect(second.status).toBe(400);
      expect((await second.json()) as { reason: string }).toMatchObject({
        reason: expect.stringContaining('not open'),
      });

      // Nothing was written: the log still holds the ask and its one answer.
      expect(ledger.read({}).entries.map((entry) => entry.body)).toEqual([
        'ship it?',
        'yes',
      ]);
    });

    /**
     * `resolveRef` matches *any* entry id, not only an ask's, so a `thread`
     * naming an ordinary post resolves — and the openness check is what stops
     * an `answer` from being written against it.
     */
    it('refuses an answer whose thread names something that was never an ask', async () => {
      const posted = await post(
        LEDGER_POST_PATH,
        { kind: 'post', body: 'just talking' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      const { id: thread } = (await posted.json()) as { id: string };

      const response = await post(
        LEDGER_POST_PATH,
        { kind: 'answer', thread, body: 'answering a post' },
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );

      expect(response.status).toBe(400);
      expect(ledger.read({}).entries).toHaveLength(1);
    });

    it('answers 413, naming the transport cap, for an oversized read query', async () => {
      const response = await post(
        LEDGER_READ_PATH,
        { since: 'x'.repeat(HOOK_MAX_BODY_BYTES + 1) },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );

      expect(response.status).toBe(413);
      expect((await response.json()) as { reason: string }).toMatchObject({
        reason: expect.stringContaining(String(HOOK_MAX_BODY_BYTES)),
      });
    });

    /**
     * An answer is private to the thread it closes (HIVE-111 ship review).
     *
     * `Ledger.answer` used to write no `to` at all, and `visibleTo` reads an
     * absent `to` as a broadcast — so the overmind's reply to one session's
     * private question was readable by every other session over this route.
     * Answered here rather than in the ledger's own spec because the leak was
     * only observable at the boundary that filters.
     */
    it('shows an answer to a private ask only to the party that asked', async () => {
      const asked = await post(
        LEDGER_POST_PATH,
        { to: 'overmind', kind: 'ask', body: 'may I merge?' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      const { id: thread } = (await asked.json()) as { id: string };

      // The overmind replies over its own (IPC) path, which is what `answer`
      // exists for; the read below is the one that crosses the wire.
      expect(ledger.answer({ thread, body: 'yes, go ahead' }, 'overmind')).toMatchObject({
        ok: true,
      });

      const asC = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-c' });
      expect(((await asC.json()) as LedgerSnapshot).entries).toEqual([]);

      const asA = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-a' });
      expect(((await asA.json()) as LedgerSnapshot).entries.map((entry) => entry.body)).toEqual([
        'may I merge?',
        'yes, go ahead',
      ]);
    });

    /**
     * The same privacy holds when the answer arrives over `POST /ledger`
     * itself — the MCP host's own path (HIVE-112 self-review).
     *
     * `ledger_answer`'s tool schema exposes no `to`, so this route is the only
     * one that can reach `Ledger.append` with `kind: 'answer'` and no `to` at
     * all; the default now lives in `append`, not only in `answer()`.
     */
    it('shows an answer POSTed with no `to` only to the party that asked', async () => {
      const asked = await post(
        LEDGER_POST_PATH,
        { to: 'sess-b', kind: 'ask', body: 'may I merge?' },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      const { id: thread } = (await asked.json()) as { id: string };

      const answered = await post(
        LEDGER_POST_PATH,
        { kind: 'answer', thread, body: 'yes, go ahead' },
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );
      expect(answered.status).toBe(200);

      const asC = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-c' });
      expect(((await asC.json()) as LedgerSnapshot).entries).toEqual([]);

      const asA = await post(LEDGER_READ_PATH, {}, { [HOOK_HEADER_SESSION]: 'sess-a' });
      expect(((await asA.json()) as LedgerSnapshot).entries.map((entry) => entry.body)).toEqual([
        'may I merge?',
        'yes, go ahead',
      ]);
    });

    /**
     * A multibyte character straddling a TCP chunk boundary (HIVE-111 ship
     * review).
     *
     * The body used to be assembled with `chunk.toString('utf8')` per chunk,
     * which decodes each chunk in isolation: a character whose bytes are split
     * across two of them became a replacement character on both sides. That
     * was survivable while the only field ever read here was an ASCII
     * `hook_event_name`; a ledger body is agent-written markdown appended to a
     * file nothing ever edits, so the mangling would be permanent.
     *
     * The write is split *inside* the two-byte `é`, and the two halves are
     * sent far enough apart (and with Nagle off) to arrive as separate `data`
     * events.
     */
    it('keeps a multibyte character that straddles a chunk boundary intact', async () => {
      const body = 'déjà vu — 🐝 ünicode';
      const payload = Buffer.from(JSON.stringify({ kind: 'post', body }), 'utf8');
      // 0xC3 is the lead byte of `é`; cutting after it leaves its continuation
      // byte in the second chunk.
      const cut = payload.indexOf(0xc3) + 1;
      expect(cut).toBeGreaterThan(0);

      const target = new URL(`${origin()}${LEDGER_POST_PATH}`);
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            headers: {
              [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-a'),
              [HOOK_HEADER_SESSION]: 'sess-a',
              'content-type': 'application/json',
              'content-length': String(payload.byteLength),
            },
          },
          (response) => {
            response.resume();
            response.on('end', () => {
              if (response.statusCode === 200) resolve();
              else reject(new Error(`unexpected status ${String(response.statusCode)}`));
            });
          },
        );
        request.on('error', reject);
        request.on('socket', (socket) => socket.setNoDelay(true));
        request.write(payload.subarray(0, cut));
        setTimeout(() => request.end(payload.subarray(cut)), 25);
      });

      expect(ledger.read({}).entries.map((entry) => entry.body)).toEqual([body]);
    });

    /**
     * The limit must apply *after* visibility, not before (HIVE-112 fold-in).
     *
     * `onLedgerRead` (via `Ledger.read`) used to take the newest `limit`
     * entries over the *whole* ledger before `visibleTo` ever ran, so an ask
     * addressed to the caller could be pushed out of that global window by
     * more-recent entries the caller cannot even see — with nothing to signal
     * the truncation. Here, more than `limit` entries addressed to a fourth
     * party land *after* an ask addressed to `sess-a`; a caller who reads with
     * that limit must still get the ask.
     */
    it('does not let entries the caller cannot see push a visible ask out of the limit', async () => {
      const asked = await post(
        LEDGER_POST_PATH,
        { to: 'sess-a', kind: 'ask', body: 'urgent: need your answer' },
        { [HOOK_HEADER_SESSION]: 'sess-b' },
      );
      expect(asked.status).toBe(200);

      const limit = 3;
      // More than `limit` entries land after the ask, all addressed to a
      // *fourth* party — invisible to `sess-a`, and deliberately not
      // broadcasts, or they would be visible to `sess-a` too and this would
      // not reproduce the bug. A limit applied over the whole log spends its
      // budget on these before `sess-a`'s visibility is ever considered,
      // pushing the (older, visible) ask out of the window entirely.
      for (let i = 0; i < limit + 2; i += 1) {
        const noise = await post(
          LEDGER_POST_PATH,
          { to: 'sess-d', kind: 'post', body: `noise ${i}` },
          { [HOOK_HEADER_SESSION]: 'sess-c' },
        );
        expect(noise.status).toBe(200);
      }

      const read = await post(
        LEDGER_READ_PATH,
        { limit },
        { [HOOK_HEADER_SESSION]: 'sess-a' },
      );
      const snapshot = (await read.json()) as LedgerSnapshot;

      // The caller still sees the ask addressed to it...
      expect(snapshot.entries.map((entry) => entry.body)).toContain(
        'urgent: need your answer',
      );
      // ...and the limit is still honoured against what it can see.
      expect(snapshot.entries.length).toBeLessThanOrEqual(limit);
    });

    /**
     * The limit itself, proven at this HTTP boundary rather than at
     * `Ledger.read` (HIVE-112 fold-in).
     *
     * The regression test above only proves an *upper* bound, and in its own
     * scenario that bound holds vacuously — `sess-a` can see just the one ask
     * either way, so `1 <= 3` says nothing about whether trimming happens at
     * all. This asserts the exact surviving entries against a caller who can
     * see every one of them, so it fails both if the trim is dropped (all
     * five would come back) and if the wrong end is kept (the oldest three
     * instead of the newest two).
     */
    it("trims the visible entries to the caller's limit", async () => {
      for (let i = 0; i < 5; i += 1) {
        const written = await post(
          LEDGER_POST_PATH,
          { to: 'sess-a', kind: 'post', body: `n${i}` },
          { [HOOK_HEADER_SESSION]: 'sess-b' },
        );
        expect(written.status).toBe(200);
      }

      const read = await post(LEDGER_READ_PATH, { limit: 2 }, { [HOOK_HEADER_SESSION]: 'sess-a' });
      const snapshot = (await read.json()) as LedgerSnapshot;

      expect(snapshot.entries.map((entry) => entry.body)).toEqual(['n3', 'n4']);
    });
  });

  it.each([
    ['SessionStart', 'idle'],
    ['UserPromptSubmit', 'working'],
    ['PermissionRequest', 'waiting'],
    ['Elicitation', 'waiting'],
    ['PostToolUse', 'working'],
    ['Stop', 'idle'],
  ])('maps %s to %s', async (event, status) => {
    const response = await post({ hook_event_name: event, session_id: 'uuid' });
    expect(response.status).toBe(204);
    expect(events).toEqual([{ entityId: 'sess-01', event, status }]);
  });

  /**
   * Tool and agent identity (HIVE-83): the tracker that pairs a permission
   * request with the tool call that resolves it needs these carried through
   * whole, not cherry-picked away with the rest of the body.
   */
  describe('tool and agent identity', () => {
    it('forwards tool identity off a PostToolUse', async () => {
      const response = await post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi', run_in_background: true },
        tool_use_id: 'toolu_01',
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({
        event: 'PostToolUse',
        toolName: 'Bash',
        toolUseId: 'toolu_01',
        runInBackground: true,
      });
    });

    it('forwards the agent id off a subagent event', async () => {
      const response = await post({
        hook_event_name: 'SubagentStart',
        agent_id: 'a828e337',
        agent_type: 'general-purpose',
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ event: 'SubagentStart', agentId: 'a828e337' });
    });

    /**
     * A `Write` or `Edit` needing permission carries the whole file in
     * `tool_input`, which is exactly what pushes the body past
     * `HOOK_MAX_BODY_BYTES`. Measured against real Claude Code 2.1.238, the
     * wire order is `..., tool_name, tool_input, tool_use_id` — so
     * `tool_name` sits before the field that grows unbounded and survives
     * truncation, while `tool_use_id` sits after it and never does.
     */
    it('recovers tool_name from an oversized PermissionRequest, but not tool_use_id', async () => {
      const response = await post({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        tool_input: 'x'.repeat(256 * 1024),
        tool_use_id: 'toolu_01',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'PermissionRequest',
          status: 'waiting',
          toolName: 'Write',
        },
      ]);
    });
  });

  /**
   * The live background-task list (HIVE-90).
   *
   * `Stop` and `SubagentStop` report what is still running, which is the only
   * thing that can see a backgrounded process **end** — Claude Code emits no
   * hook when one dies. The bodies below are the measured shape, 2.1.245.
   */
  describe('background tasks', () => {
    it('forwards the ids of the tasks a Stop reports running', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'Started it.',
        background_tasks: [
          {
            id: 'bcy0lrc5b',
            type: 'shell',
            status: 'running',
            description: 'Run sleep 40 then echo in background',
            command: 'sleep 40; echo finished-bg',
          },
        ],
        session_crons: [],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({
        event: 'Stop',
        backgroundShells: ['bcy0lrc5b'],
      });
    });

    /**
     * The case HIVE-90 exists for: an **observed** empty list. It must survive
     * as `[]` and not be dropped for looking falsy — absence means the body
     * did not say, and the tracker keeps inferring on that.
     */
    it('forwards an empty list as an observation, not as silence', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        last_assistant_message: 'It printed finished-bg.',
        background_tasks: [],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ event: 'Stop', backgroundShells: [] });
    });

    it('says nothing for an event that carries no list at all', async () => {
      const response = await post({ hook_event_name: 'Stop' });

      expect(response.status).toBe(204);
      expect(events[0]).not.toHaveProperty('backgroundShells');
    });

    it('carries the list off a SubagentStop too', async () => {
      const response = await post({
        hook_event_name: 'SubagentStop',
        agent_id: 'a95ea9629a0d69ec6',
        background_tasks: [
          { id: 'bcy0lrc5b', type: 'shell', status: 'running' },
        ],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({
        event: 'SubagentStop',
        agentId: 'a95ea9629a0d69ec6',
        backgroundShells: ['bcy0lrc5b'],
      });
    });

    /**
     * A task listed under any other status is not something the session is
     * parked on, and an entry with no usable id is nothing this app can hold.
     * Both are dropped — but the list stays an observation, so a body whose
     * every entry is dropped still reports `[]` rather than falling silent.
     */
    it('keeps only running tasks that name themselves', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a', type: 'shell', status: 'running' },
          { id: 'b', type: 'shell', status: 'completed' },
          { id: '', type: 'shell', status: 'running' },
          { type: 'shell', status: 'running' },
          'not an object',
          null,
        ],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ backgroundShells: ['a'] });
    });

    /**
     * `background_tasks` is a union, and a live **subagent** sits in it under
     * `type: 'subagent'` (measured, 2.1.245). Counting one as a shell is how
     * the first cut of HIVE-90 turned a session's `idle (agents)` into
     * `idle (script)`; `SubagentStart` / `SubagentStop` is the finer and
     * fresher signal for agents, so entries of that type are dropped here.
     * The list is still an observation, so a body of nothing but subagents
     * reports `[]` — there really is no shell running.
     */
    it('drops a subagent, which is not a background shell', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        background_tasks: [
          {
            id: 'a1bb2b63ce60a4e1c',
            type: 'subagent',
            status: 'running',
            agent_type: 'general-purpose',
            description: 'Run bash command and report output',
          },
        ],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ backgroundShells: [] });
    });

    it('keeps the shell out of a list that mixes the two', async () => {
      const response = await post({
        hook_event_name: 'SubagentStop',
        agent_id: 'a1bb2b63ce60a4e1c',
        background_tasks: [
          { id: 'a1bb2b63ce60a4e1c', type: 'subagent', status: 'running' },
          { id: 'bcy0lrc5b', type: 'shell', status: 'running' },
        ],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ backgroundShells: ['bcy0lrc5b'] });
    });

    /**
     * A background task type this app has never seen is dropped with the
     * subagents — see `liveBackgroundShellIds` for the trade. `script` names a
     * shell, and assigning an unknown kind to it would repeat the subagent
     * mistake in the other direction. Dropped, but **not silently**: this is
     * the one path that can bring a wrong `idle` back, and the live
     * conformance test needs a real binary and an opt-in env var to see it.
     */
    it('drops a background task type it does not know, and says so once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await post({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'z', type: 'something-new', status: 'running' }],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ backgroundShells: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('something-new');

      // Once per kind per receiver, not once per `Stop` — see `warnedTaskTypes`.
      await post({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'z', type: 'something-new', status: 'running' }],
      });
      expect(warn).toHaveBeenCalledTimes(1);

      // A second unrecognised kind is its own news.
      await post({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'q', type: 'another-new', status: 'running' }],
      });
      expect(warn).toHaveBeenCalledTimes(2);

      warn.mockRestore();
    });

    /**
     * The two kinds this app *does* have a reading for stay quiet — a warning
     * on every `Stop` of an ordinary subagent run would be noise, and noise is
     * how a real warning stops being read.
     */
    it('says nothing about the kinds it understands', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await post({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a1bb2b63ce60a4e1c', type: 'subagent', status: 'running' },
          { id: 'bcy0lrc5b', type: 'shell', status: 'running' },
          // Not running, so not a missed detail whatever its kind is.
          { id: 'gone', type: 'something-new', status: 'completed' },
        ],
      });

      expect(events[0]).toMatchObject({ backgroundShells: ['bcy0lrc5b'] });
      expect(warn).not.toHaveBeenCalled();

      warn.mockRestore();
    });

    /**
     * `last_assistant_message` precedes `background_tasks` on the wire, so a
     * final message over `HOOK_MAX_BODY_BYTES` truncates the list away. The
     * receiver must then say nothing rather than report an empty one — this is
     * the residual limitation armedIdle's doc records.
     */
    it('says nothing about a list an oversized body truncated away', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        last_assistant_message: 'x'.repeat(128 * 1024),
        background_tasks: [{ id: 'a', type: 'shell', status: 'running' }],
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ event: 'Stop', status: 'idle' });
      expect(events[0]).not.toHaveProperty('backgroundShells');
    });
  });

  /**
   * `SessionEnd` and the `reason` gate.
   *
   * Only `clear` may be acted on. The others all mean the process is going
   * away, which the pty observes and reports as `terminated` — and acting on
   * them here is the exact bug this event was once withdrawn for: it locked the
   * user out of a live session by calling `/clear` a death.
   */
  it('reports a cleared session, and never as a status', async () => {
    const response = await post({
      hook_event_name: 'SessionEnd',
      reason: 'clear',
      session_id: 'uuid',
    });

    expect(response.status).toBe(204);
    expect(cleared).toEqual(['sess-01']);
    // Crucially not a status — `terminated` here is what broke it before.
    expect(events).toEqual([]);
  });

  it.each(['prompt_input_exit', 'logout', 'other'])(
    'ignores SessionEnd with reason %s — the pty owns that verdict',
    async (reason) => {
      const response = await post({
        hook_event_name: 'SessionEnd',
        reason,
        session_id: 'uuid',
      });

      expect(response.status).toBe(204);
      expect(cleared).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  it('ignores a SessionEnd with no reason at all', async () => {
    const response = await post({ hook_event_name: 'SessionEnd' });

    expect(response.status).toBe(204);
    expect(cleared).toEqual([]);
  });

  it('does not report a cleared session the app has never heard of', async () => {
    const response = await post(
      { hook_event_name: 'SessionEnd', reason: 'clear' },
      { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'), [HOOK_HEADER_SESSION]: 'sess-gone' },
    );

    expect(response.status).toBe(404);
    expect(cleared).toEqual([]);
  });

  it('rejects a request with no token', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_SESSION]: 'sess-01' },
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('rejects a request with the wrong token', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: 'not-the-token', [HOOK_HEADER_SESSION]: 'sess-01' },
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('rejects a request naming no session', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01') },
    );
    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('refuses a session the app does not have', async () => {
    /**
     * A hook for an exited session must not create state for it — that is how a
     * long-running app accumulates one entry per stale session forever.
     */
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'), [HOOK_HEADER_SESSION]: 'sess-gone' },
    );
    expect(response.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('accepts an unsubscribed event without acting on it', async () => {
    /**
     * 204 rather than 4xx: Claude may deliver more than was asked for, and a
     * failing hook prints an error in the user's session for something the app
     * simply does not care about.
     *
     * `PreCompact` rather than `PreToolUse` (HIVE-83): the latter is now
     * subscribed too — see the bookkeeping pair in `HOOK_EVENTS`.
     */
    const response = await post({ hook_event_name: 'PreCompact' });
    expect(response.status).toBe(204);
    expect(events).toEqual([]);
  });

  /**
   * The `Notification` hook — the only event whose status is not a
   * property of the event.
   *
   * Measured against Claude Code 2.1.227 in a real pty: `idle_prompt` sixty
   * seconds after a turn ended with nothing typed, `permission_prompt` about
   * six seconds after a permission prompt appears. Both mean the session is
   * blocked on a human; what they mean for the *inbox* is decided downstream.
   */
  describe('the Notification hook', () => {
    /**
     * HIVE-81: the two types no longer share a status. `permission_prompt` is a
     * session blocked on a human; `idle_prompt` fires a minute after the turn
     * already ended, and `idle` is what the session already was.
     */
    it.each([
      ['idle_prompt', 'idle'],
      ['permission_prompt', 'waiting'],
    ])(
      'maps %s to %s, carrying the type through',
      async (notificationType, status) => {
        const response = await post({
          hook_event_name: 'Notification',
          notification_type: notificationType,
          message: 'Claude is waiting for your input',
        });

        expect(response.status).toBe(204);
        expect(events).toEqual([
          {
            entityId: 'sess-01',
            event: 'Notification',
            status,
            notificationType,
          },
        ]);
      },
    );

    /**
     * Claude raises notifications this build has no reading of. Moving a
     * session to `waiting` on one would put a dot on the rail that no amount of
     * looking at the terminal explains — and a 4xx would print a hook failure
     * in the user's session for something the app simply does not care about.
     */
    it('publishes nothing for a type it does not know, and still answers 204', async () => {
      const response = await post({
        hook_event_name: 'Notification',
        notification_type: 'something_new',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([]);
    });

    it('publishes nothing for a Notification carrying no type', async () => {
      const response = await post({ hook_event_name: 'Notification' });

      expect(response.status).toBe(204);
      expect(events).toEqual([]);
    });

    /**
     * A `Notification` payload carries the prose Claude would have shown, which
     * is unbounded — so the type has to survive the same truncation the event
     * name does, or the biggest ones would silently stop reporting.
     */
    it('reads the type out of an oversized body', async () => {
      const response = await post({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'x'.repeat(256 * 1024),
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'Notification',
          status: 'idle',
          notificationType: 'idle_prompt',
        },
      ]);
    });

    it('carries the cwd along, as every other event does', async () => {
      await post({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        cwd: '/repos/nova-web',
      });

      expect(events[0].cwd).toBe('/repos/nova-web');
    });
  });

  it('rejects a malformed body', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('still acts on an oversized body instead of rejecting it', async () => {
    /**
     * The biggest payloads belong to `PermissionRequest`, whose `tool_input`
     * for a Write or an Edit is a whole file — so refusing them with 413 meant
     * a large edit never raised `waiting`, the one state the attention model
     * exists for. The body is drained past the cap; only the prefix is kept,
     * and `hook_event_name` lives there.
     */
    const response = await post({
      hook_event_name: 'PermissionRequest',
      tool_input: 'x'.repeat(256 * 1024),
    });

    expect(response.status).toBe(204);
    expect(events).toEqual([
      { entityId: 'sess-01', event: 'PermissionRequest', status: 'waiting' },
    ]);
  });

  it('ignores an oversized body whose event name is past the cap', async () => {
    // Nothing to act on, and still not an error the user's session must show.
    const response = await post({
      tool_input: 'x'.repeat(256 * 1024),
      hook_event_name: 'Stop',
    });

    expect(response.status).toBe(204);
    expect(events).toEqual([]);
  });

  /**
   * The `cwd` half of HIVE-78.
   *
   * `docs/branch-sync-note.md` listed "the session's live working directory" as
   * the first thing main did not have, and proposed inspecting the shell
   * process with `lsof` to get it. These tests record that it was already in
   * the payload — and that it is the *agent's* cwd, so it follows a session
   * into a worktree.
   */
  describe('cwd', () => {
    it('carries the working directory out with the status', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        cwd: '/repo/.claude/worktrees/incorp-332',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'Stop',
          status: 'idle',
          cwd: '/repo/.claude/worktrees/incorp-332',
        },
      ]);
    });

    it.each([
      ['absent', {}],
      ['empty', { cwd: '' }],
      ['not a string', { cwd: 42 }],
    ])('omits the field when the payload carries none (%s)', async (_label, extra) => {
      // Absent rather than empty: the session layer reads absence as "nothing
      // to look at on this tick", and an empty string would be a directory.
      const response = await post({ hook_event_name: 'Stop', ...extra });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        { entityId: 'sess-01', event: 'Stop', status: 'idle' },
      ]);
    });

    it('recovers the directory from an oversized body', async () => {
      // Same prefix trick the event name already relies on: a
      // `PermissionRequest` carrying a whole file is exactly the event that
      // produces `waiting`, and it must still say where it happened.
      const response = await post({
        hook_event_name: 'PermissionRequest',
        cwd: '/repo/worktree',
        tool_input: 'x'.repeat(256 * 1024),
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'PermissionRequest',
          status: 'waiting',
          cwd: '/repo/worktree',
        },
      ]);
    });
  });

  describe('ticket intent', () => {
    it('reports a key the prompt claimed, before the status', async () => {
      /**
       * Ordering is asserted, not incidental: `onEvent` is what makes the
       * session `working`, and a renderer that learned the ticket second would
       * render the row under its old name for a frame — a visible flicker, on
       * exactly the frame the user pressed enter.
       */
      const order: string[] = [];
      const ordered = createReceiver({
        onCleared: () => {},
        onEvent: () => order.push('status'),
        onTicketIntent: () => order.push('intent'),
        onDone: () => {},
        onReady: () => {},
        knowsSession: () => true,
        onMetrics: () => {},
        ...noLedger,
      });
      const started = (await ordered.start()) as string;

      await fetch(started, {
        method: 'POST',
        headers: {
          [HOOK_HEADER_TOKEN]: ordered.tokenFor('sess-01'),
          [HOOK_HEADER_SESSION]: 'sess-01',
        },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'work on ABC-123',
        }),
      });

      expect(order).toEqual(['intent', 'status']);
      await ordered.stop();
    });

    it('carries the key and nothing else', async () => {
      // The prompt never travels. The receiver exists to keep a status dot
      // honest, not to forward what the user typed.
      const response = await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'work on the ticket ABC-123 please',
      });

      expect(response.status).toBe(204);
      expect(intents).toEqual([
        { entityId: 'sess-01', key: 'ABC-123', source: 'prompt' },
      ]);
    });

    it('says nothing when the prompt only mentions a ticket', async () => {
      await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'the PR for ABC-123 broke CI',
      });

      expect(intents).toEqual([]);
    });

    it('ignores prompts on every other event', async () => {
      // Only `UserPromptSubmit` carries something the user just said. A
      // `prompt` field on any other event is not a fresh statement of intent.
      await post({ hook_event_name: 'Stop', prompt: 'work on ABC-123' });

      expect(intents).toEqual([]);
    });

    it('does not scan a truncated body', async () => {
      /**
       * A truncated body means the payload exceeded 64 KB — a paste, which is
       * the worst input for a shape test and the least likely to be "work on
       * ABC-123". The status still lands; only the intent is skipped.
       */
      const response = await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: `work on ABC-123 ${'x'.repeat(256 * 1024)}`,
      });

      expect(response.status).toBe(204);
      expect(intents).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('reports nothing for a session the app does not have', async () => {
      const response = await post(
        { hook_event_name: 'UserPromptSubmit', prompt: 'work on ABC-123' },
        { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'), [HOOK_HEADER_SESSION]: 'sess-gone' },
      );

      expect(response.status).toBe(404);
      expect(intents).toEqual([]);
    });
  });

  it('serves only its own path and method', async () => {
    expect((await fetch(url.replace('/hook', '/'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(url, { method: 'GET' })).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('answers nothing once stopped', async () => {
    await receiver.stop();
    await expect(post({ hook_event_name: 'Stop' })).rejects.toThrow();
  });

  it('reports a bind failure as null rather than throwing', async () => {
    /**
     * The contract the whole design leans on: a receiver that cannot bind must
     * degrade status, never break a spawn. Port 1 is privileged, so binding it
     * as an ordinary user fails.
     */
    const doomed = createReceiver({
    onCleared: () => {},
      onEvent: () => {},
      onTicketIntent: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: () => true,
      onMetrics: () => {},
      ...noLedger,
      port: 1,
    });
    await expect(doomed.start()).resolves.toBeNull();
    await doomed.stop();
  });

  it('survives a throwing listener without taking the process down', async () => {
    const exploding = createReceiver({
    onCleared: () => {},
      onEvent: () => {
        throw new Error('listener blew up');
      },
      onTicketIntent: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: () => true,
      onMetrics: () => {},
      ...noLedger,
    });
    const started = await exploding.start();
    const response = await fetch(started as string, {
      method: 'POST',
      headers: {
        [HOOK_HEADER_TOKEN]: exploding.tokenFor('sess-01'),
        [HOOK_HEADER_SESSION]: 'sess-01',
      },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });
    expect(response.status).toBe(500);
    await exploding.stop();
  });
});

/**
 * The whole point of HIVE-112: a token proves the session it was derived for,
 * and nothing else — on every route this receiver serves, not only the ledger
 * ones a curious model has a reason to try.
 *
 * Before this change, `reject` compared the presented token against one
 * secret shared by every session, so any known session's token unlocked every
 * other known session's identity. `impersonates()` below is the regression
 * test for exactly that: session A's own, genuinely valid token, presented
 * with session B's header. It must be refused on all six routes.
 */
describe('the token binds to one session (HIVE-112)', () => {
  let receiver: Receiver;
  let dir: string;

  const VALID_METRICS = {
    model: { display_name: 'Opus 4.5' },
    context_window: { used_percentage: 10, context_window_size: 1_000_000 },
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: 1 },
      seven_day: { used_percentage: 1, resets_at: 1 },
    },
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hive-receiver-token-binding-'));
    const ledger = createLedger({ dir, knowsParty: () => true });
    receiver = createReceiver({
      onCleared: () => {},
      onEvent: () => {},
      onTicketIntent: () => {},
      onDone: () => {},
      onReady: () => {},
      onMetrics: () => {},
      knowsSession: (entityId) => entityId === 'sess-a' || entityId === 'sess-b',
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One entry per route this receiver answers. `ok` is the status a *correctly*
   * paired request gets, so the table doubles as proof that the pairing check
   * does not accidentally break the happy path on any of them.
   */
  const ROUTES: { name: string; url: (r: Receiver) => string; body: unknown; ok: number }[] = [
    {
      name: '/hook',
      url: (r) => r.url as string,
      body: { hook_event_name: 'Stop' },
      ok: 204,
    },
    {
      name: '/metrics',
      url: (r) => r.metricsUrl as string,
      body: VALID_METRICS,
      ok: 204,
    },
    { name: '/done', url: (r) => r.doneUrl as string, body: {}, ok: 204 },
    { name: '/ready', url: (r) => r.readyUrl as string, body: {}, ok: 204 },
    {
      name: '/ledger',
      url: (r) => `${r.origin as string}${LEDGER_POST_PATH}`,
      body: { kind: 'post', body: 'hi' },
      ok: 200,
    },
    {
      name: '/ledger/read',
      url: (r) => `${r.origin as string}${LEDGER_READ_PATH}`,
      body: {},
      ok: 200,
    },
  ];

  const send = (target: string, token: string, session: string, body: unknown) =>
    fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HOOK_HEADER_TOKEN]: token,
        [HOOK_HEADER_SESSION]: session,
      },
      body: JSON.stringify(body),
    });

  it.each(ROUTES)(
    'refuses session A\'s own valid token presented as session B on $name',
    async ({ url, body }) => {
      const response = await send(
        url(receiver),
        receiver.tokenFor('sess-a'),
        'sess-b',
        body,
      );

      expect(response.status).toBe(403);
    },
  );

  it.each(ROUTES)('accepts the matching pair on $name', async ({ url, body, ok }) => {
    const response = await send(url(receiver), receiver.tokenFor('sess-a'), 'sess-a', body);

    expect(response.status).toBe(ok);
  });

  it.each(ROUTES)('refuses an unknown, garbage token on $name', async ({ url, body }) => {
    const response = await send(url(receiver), 'not-a-real-token', 'sess-a', body);

    expect(response.status).toBe(403);
  });

  it.each(ROUTES)(
    'refuses a token derived by a different receiver for the same session on $name',
    async ({ url, body }) => {
      const impostor = createReceiver({
        onCleared: () => {},
        onEvent: () => {},
        onTicketIntent: () => {},
        onDone: () => {},
        onReady: () => {},
        onMetrics: () => {},
        knowsSession: () => true,
        ...noLedger,
      });

      const response = await send(url(receiver), impostor.tokenFor('sess-a'), 'sess-a', body);

      expect(response.status).toBe(403);
    },
  );

  it('is deterministic: the same receiver and id yield the same token twice', () => {
    expect(receiver.tokenFor('sess-a')).toBe(receiver.tokenFor('sess-a'));
  });
});

describe('hook receiver tokens', () => {
  it('derives a different token for the same session id on two receivers', () => {
    // Two receivers, each with their own launch secret, minting a token for
    // *the same* session id — the launch secret is what has to differ for
    // this to hold, since `tokenFor` is otherwise a pure function of its
    // argument (HIVE-112).
    const a = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, onReady: () => {}, knowsSession: () => true, ...noLedger });
    const b = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, onReady: () => {}, knowsSession: () => true, ...noLedger });
    expect(a.tokenFor('sess-01')).not.toBe(b.tokenFor('sess-01'));
    // Hex-encoded SHA-256, not a v4 uuid.
    expect(a.tokenFor('sess-01')).toHaveLength(64);
    expect(a.tokenFor('sess-01')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same receiver and session id always agree', () => {
    const receiver = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, onReady: () => {}, knowsSession: () => true, ...noLedger });
    expect(receiver.tokenFor('sess-01')).toBe(receiver.tokenFor('sess-01'));
  });

  it('derives a different token for a different session id on the same receiver', () => {
    const receiver = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, onReady: () => {}, knowsSession: () => true, ...noLedger });
    expect(receiver.tokenFor('sess-01')).not.toBe(receiver.tokenFor('sess-02'));
  });

  it('has no url before it starts', () => {
    const receiver = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, onReady: () => {}, knowsSession: () => true, ...noLedger });
    expect(receiver.url).toBeNull();
  });
});


/**
 * The status line path (HIVE-79).
 *
 * Same socket, same token, same session header — a different body shape and a
 * much smaller cap. These assertions are mostly about the ways it must *refuse*,
 * because it is a second door on a socket the receiver's own header argues hard
 * for the safety of.
 */
describe('the status line path', () => {
  let receiver: Receiver;
  let metrics: { entityId: string; reported: SessionMetrics }[];
  let url: string;

  beforeEach(async () => {
    metrics = [];
    receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: (entityId, reported) => metrics.push({ entityId, reported }),
      onDone: () => {},
      onReady: () => {},
      knowsSession: (entityId) => entityId !== 'sess-gone',
      ...noLedger,
    });
    const started = await receiver.start();
    expect(started).not.toBeNull();
    url = receiver.metricsUrl as string;
  });

  afterEach(async () => {
    await receiver.stop();
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = {
      [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01'),
      [HOOK_HEADER_SESSION]: 'sess-01',
    },
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('is a second path on the same socket', () => {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(url.endsWith(METRICS_PATH)).toBe(true);
  });

  it('is null before a successful bind', () => {
    const unbound = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: () => true,
      ...noLedger,
    });
    expect(unbound.metricsUrl).toBeNull();
  });

  it('records what a session reported', async () => {
    const response = await post({
      model: { display_name: 'Opus 4.5' },
      context_window: { used_percentage: 46, context_window_size: 1000000 },
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1786000000 },
        seven_day: { used_percentage: 63, resets_at: 1786200000 },
      },
    });

    expect(response.status).toBe(204);
    expect(metrics).toEqual([
      {
        entityId: 'sess-01',
        reported: {
          model: 'Opus 4.5',
          contextPct: 46,
          contextWindow: 1000000,
          fiveHourPct: 12,
          fiveHourResetsAt: 1786000000,
          sevenDayPct: 63,
          sevenDayResetsAt: 1786200000,
        },
      },
    ]);
  });

  it('rejects a request with the wrong token, exactly as the hook path does', async () => {
    const response = await post(
      {},
      { [HOOK_HEADER_TOKEN]: 'not-the-token', [HOOK_HEADER_SESSION]: 'sess-01' },
    );

    expect(response.status).toBe(403);
    expect(metrics).toEqual([]);
  });

  it('rejects a request naming no session', async () => {
    const response = await post({}, { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-01') });

    expect(response.status).toBe(400);
    expect(metrics).toEqual([]);
  });

  it('refuses a session the app does not have', async () => {
    const response = await post(
      {},
      { [HOOK_HEADER_TOKEN]: receiver.tokenFor('sess-gone'), [HOOK_HEADER_SESSION]: 'sess-gone' },
    );

    expect(response.status).toBe(404);
    expect(metrics).toEqual([]);
  });

  it('answers 400 for a body that is not an object', async () => {
    expect((await post('{ not json')).status).toBe(400);
    expect(metrics).toEqual([]);
  });

  /**
   * A status line payload is a fixed set of scalars. Anything approaching the
   * cap is not the document this endpoint is for — answered 204 rather than 413
   * for the reason the hook path drains rather than refuses: the reply is
   * visible in the user's terminal.
   */
  it('drops an oversized body without acting on it, and still answers 204', async () => {
    const response = await post({ padding: 'x'.repeat(32 * 1024) });

    expect(response.status).toBe(204);
    expect(metrics).toEqual([]);
  });

  it('answers 404 on the metrics path for a method other than POST', async () => {
    expect((await fetch(url, { method: 'GET' })).status).toBe(404);
  });
});
