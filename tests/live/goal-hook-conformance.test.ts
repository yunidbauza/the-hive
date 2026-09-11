// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writePluginDir } from '../../electron/main/skills/plugin';
import { readUserSkills } from '../../electron/main/skills/read';

/**
 * The goal-on Stop hook, against a real `claude` (HIVE-165).
 *
 * Two claims no unit test can make, and the whole of `goal-on` rests on
 * both:
 *
 * 1. **A Stop hook declared in a skill's frontmatter registers when the skill
 *    arrives through the Hive's generated `--plugin-dir` plugin.** claude-kit
 *    proved it for a plugin installed under `~/.claude`; the Hive delivers the
 *    same skill through a directory the app regenerates per spawn, and nothing
 *    but the binary can say whether that path is treated the same.
 * 2. **The hook process inherits the receiver environment**, so the verifier's
 *    ledger receipt actually reaches `POST /ledger` with the session's headers.
 *
 * A skill's frontmatter hooks register **when the skill is invoked**, not at
 * session start (measured: a run that never invoked `goal-on` left the brief
 * untouched). So the prompt is `/goal-on clear`, the cheapest invocation the
 * skill has, and the model is given `Read` only so it answers and stops
 * rather than editing anything. The brief the verifier reads sits under
 * `HIVE_GOALS_DIR`, which the model does not know about, so whatever the
 * model does to `~/.hive/goals` is not what is measured.
 *
 * The brief is written `ACTIVE` with one unticked Outcome and `turn_budget: 1`,
 * so the cheapest possible run proves the block: the first Stop is refused
 * (turns 0 → 1), the second finds the budget spent and writes `FAILED`. Both
 * writes stamp `last_verified`, and each posts a receipt. Asserting on the
 * file rather than on the model's words is the point: a hook that never ran
 * leaves no stamp, whatever the transcript says.
 *
 * Opt-in like every live suite: `pnpm test:goal`. Skipped, not failed,
 * without the flag; a missing `claude` fails loudly, as `skills-conformance`
 * does.
 */
const enabled = process.env['HIVE_LIVE_GOAL_PROOF'] === '1';

interface Receipt {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const stub = (): Promise<{ server: Server; url: string; receipts: Receipt[] }> =>
  new Promise((resolve) => {
    const receipts: Receipt[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        if (request.url === '/ledger' && request.method === 'POST') {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            // Keep the raw text; the assertion will say what arrived.
          }
          receipts.push({ headers: request.headers, body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
          return;
        }
        response.writeHead(204);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, receipts });
    });
  });

describe.skipIf(!enabled)('goal-on Stop hook through the generated plugin (HIVE-165)', () => {
  let pluginRoot: string;
  let goals: string;
  let cwd: string;
  let receiver: { server: Server; url: string; receipts: Receipt[] };

  beforeAll(async () => {
    const resources = new URL('../../resources', import.meta.url).pathname;
    const read = await readUserSkills(join(resources, 'skills'));
    expect(read.invalid).toEqual([]);
    pluginRoot = join(mkdtempSync(join(tmpdir(), 'hive-goal-plugin-')), 'plugin');
    await writePluginDir(pluginRoot, '0.0.0-test', read);
    goals = mkdtempSync(join(tmpdir(), 'hive-goals-'));
    cwd = mkdtempSync(join(tmpdir(), 'hive-goal-cwd-'));
    receiver = await stub();
  });

  afterAll(() => {
    receiver.server.close();
  });

  it(
    'blocks the turn, stamps the brief, and posts a receipt for every status it writes',
    { timeout: 300_000 },
    async () => {
      const session = randomUUID();
      const brief = join(goals, `${session}.md`);
      mkdirSync(goals, { recursive: true });
      writeFileSync(
        brief,
        [
          '---',
          'status: ACTIVE',
          'route: artifact',
          'turns_used: 0',
          'turn_budget: 1',
          `session: ${session}`,
          '---',
          '',
          '## Task',
          'Prove the Stop hook registers through the generated plugin.',
          '',
          '## Outcome',
          '- [ ] A box nobody will tick.',
          '',
          '## Verification evidence',
          '',
        ].join('\n'),
        'utf8',
      );

      const token = `test-${randomUUID()}`;
      const run = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        execFile(
          'claude',
          [
            '--plugin-dir',
            pluginRoot,
            '--session-id',
            session,
            '--model',
            'haiku',
            '--max-turns',
            '8',
            '--allowedTools',
            'Read',
            '-p',
            '/goal-on clear',
          ],
          {
            cwd,
            timeout: 240_000,
            maxBuffer: 10 * 1024 * 1024,
            env: {
              ...process.env,
              HIVE_GOALS_DIR: goals,
              HIVE_RECEIVER_URL: receiver.url,
              HIVE_HOOK_TOKEN: token,
              HIVE_SESSION_ID: session,
            },
          },
          (_error, stdout, stderr) => resolve({ stdout, stderr }),
        );
      });

      const after = readFileSync(brief, 'utf8');
      // Written before any assertion, so a failed run still leaves its evidence.
      writeFileSync(
        join(cwd, 'finding.json'),
        JSON.stringify({ run, after, receipts: receiver.receipts }, null, 2),
        'utf8',
      );
      console.info('EVIDENCE ', join(cwd, 'finding.json'));
      // The floor ran: it stamps on every completed path, blocked or released.
      expect(after).toMatch(/^last_verified: \d{4}-/m);
      // It blocked once (turns 0 → 1) and then spent the budget.
      expect(after).toMatch(/^turns_used: 1$/m);
      expect(after).toMatch(/^status: FAILED$/m);

      // The receipt reached the receiver with the session's own headers.
      const events = receiver.receipts.filter(
        (receipt) => (receipt.body as { kind?: string })?.kind === 'event',
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const receipt of events) {
        expect(receipt.headers['x-hive-token']).toBe(token);
        expect(receipt.headers['x-hive-session']).toBe(session);
        expect((receipt.body as { meta: { goal: string } }).meta.goal).toBe(session);
      }
      const statuses = events.map((receipt) => (receipt.body as { meta: { status: string } }).meta.status);
      expect(statuses).toContain('FAILED');
    },
  );
});
