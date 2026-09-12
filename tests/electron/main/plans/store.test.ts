import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlans, type PlanToolCall } from '../../../../electron/main/plans';
import { parsePlanFile } from '../../../../electron/main/plans/parse-plan-file';
import { CH } from '../../../../electron/shared/ipc-contract';
import { PLAN_GRACE_MS, type SessionPlan } from '../../../../electron/shared/plan-contract';

const create = (id: string, subject: string, entityId = 'sess-01'): PlanToolCall => ({
  entityId,
  toolName: 'TaskCreate',
  toolInput: { subject },
  toolResponse: { task: { id, subject } },
});

const update = (taskId: string, status: string): PlanToolCall => ({
  entityId: 'sess-01',
  toolName: 'TaskUpdate',
  toolInput: { taskId, status },
  toolResponse: {},
});

const modePlan: SessionPlan = {
  entityId: 'sess-01',
  source: 'plan-mode',
  tasks: [{ id: '1', title: 'P', status: 'pending' }],
  allDone: false,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPlans', () => {
  it('publishes each change on CH.planChanged', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool(create('1', 'A'));

    expect(send).toHaveBeenLastCalledWith(CH.planChanged, {
      entityId: 'sess-01',
      plan: expect.objectContaining({ tasks: [{ id: '1', title: 'A', status: 'pending' }] }),
    });
  });

  it('does not publish a call that changed nothing', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('9', 'completed'));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores a tool that is not a task tool', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool({ entityId: 'sess-01', toolName: 'Read', toolInput: {}, toolResponse: {} });

    expect(send).not.toHaveBeenCalled();
    expect(plans.get('sess-01')).toBeUndefined();
  });

  it('drops an all-done plan after the grace period, and a new change cancels the drop', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'completed'));

    expect(plans.get('sess-01')?.allDone).toBe(true);

    vi.advanceTimersByTime(PLAN_GRACE_MS - 1);

    expect(plans.get('sess-01')).toBeDefined();

    // A new plan inside the grace window.
    plans.onTool(create('2', 'B'));
    vi.advanceTimersByTime(PLAN_GRACE_MS);

    expect(plans.get('sess-01')?.tasks.map((t) => t.id)).toEqual(['2']);
  });

  it('publishes plan: null on drop', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'completed'));
    vi.advanceTimersByTime(PLAN_GRACE_MS);

    expect(plans.get('sess-01')).toBeUndefined();
    expect(send).toHaveBeenLastCalledWith(CH.planChanged, { entityId: 'sess-01', plan: null });
  });

  it('honours a custom grace period', () => {
    const plans = createPlans({ send: vi.fn(), graceMs: 10 });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'completed'));
    vi.advanceTimersByTime(10);

    expect(plans.get('sess-01')).toBeUndefined();
  });

  it('drops on demand, and a second drop publishes nothing', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool(create('1', 'A'));
    plans.drop('sess-01');
    plans.drop('sess-01');

    expect(plans.get('sess-01')).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(CH.planChanged, { entityId: 'sess-01', plan: null });
  });

  it('drops a plan whose last task was deleted', () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'deleted'));

    expect(plans.get('sess-01')).toBeUndefined();
    expect(send).toHaveBeenLastCalledWith(CH.planChanged, { entityId: 'sess-01', plan: null });
  });

  it('a higher rank replaces a lower one; a lower rank never overwrites a live higher one', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.offer('sess-01', 'plan-mode', modePlan);

    expect(plans.get('sess-01')?.source).toBe('plan-mode');

    plans.onTool(create('1', 'A'));

    expect(plans.get('sess-01')?.source).toBe('task-tools');

    plans.offer('sess-01', 'plan-file', { ...modePlan, source: 'plan-file' });

    expect(plans.get('sess-01')?.source).toBe('task-tools');
  });

  it('a lower rank replaces an all-done higher one', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'completed'));
    plans.offer('sess-01', 'plan-mode', modePlan);

    expect(plans.get('sess-01')).toBe(modePlan);
  });

  it('an offer of nothing drops the plan', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.offer('sess-01', 'plan-mode', modePlan);
    plans.offer('sess-01', 'plan-mode', undefined);

    expect(plans.get('sess-01')).toBeUndefined();
  });

  it('lists every plan', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.onTool(create('1', 'A'));
    plans.onTool(create('1', 'B', 'sess-02'));

    expect(plans.list().map((p) => p.entityId).sort()).toEqual(['sess-01', 'sess-02']);
  });

  it('dispose cancels pending drops', () => {
    const plans = createPlans({ send: vi.fn() });

    plans.onTool(create('1', 'A'));
    plans.onTool(update('1', 'completed'));
    plans.dispose();
    vi.advanceTimersByTime(PLAN_GRACE_MS);

    expect(plans.get('sess-01')?.allDone).toBe(true);
  });
});

/**
 * Sources 2 and 3 (HIVE-180): the plan file, read from disk under
 * confinement, and plan mode's approved plan. `onTool` returns the read's
 * promise for a plan-file call so a test can await it.
 */
describe('createPlans: plan file and plan mode (HIVE-180)', () => {
  const PLAN_TEXT = '## Task 1: A\n- [x] one\n- [ ] two\n## Task 2: B\n- [ ] three\n';

  let root: string;
  let file: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-plan-store-')));
    mkdirSync(join(root, '.hive', 'plans'), { recursive: true });
    file = join(root, '.hive', 'plans', 'p.md');
    writeFileSync(file, PLAN_TEXT);
  });

  const fileCall = (toolName = 'Write', extra: Partial<PlanToolCall> = {}): PlanToolCall => ({
    entityId: 'sess-01',
    toolName,
    toolInput: { file_path: file },
    toolResponse: undefined,
    cwd: root,
    ...extra,
  });

  const planMode = (plan: string): PlanToolCall => ({
    entityId: 'sess-01',
    toolName: 'ExitPlanMode',
    toolInput: { plan },
    toolResponse: {},
  });

  it('reads a plan file into a plan-file plan and publishes it', async () => {
    const send = vi.fn();
    const plans = createPlans({ send });

    await plans.onTool(fileCall());

    const expected = {
      entityId: 'sess-01',
      source: 'plan-file',
      file,
      tasks: parsePlanFile(PLAN_TEXT),
      allDone: false,
    };
    expect(plans.get('sess-01')).toEqual(expected);
    expect(send).toHaveBeenLastCalledWith(CH.planChanged, { entityId: 'sess-01', plan: expected });
  });

  it('re-reads on the next Edit, so ticking the last step completes a task', async () => {
    const plans = createPlans({ send: vi.fn() });
    await plans.onTool(fileCall());

    writeFileSync(file, PLAN_TEXT.replace('- [ ] two', '- [x] two'));
    await plans.onTool(fileCall('Edit'));

    expect(plans.get('sess-01')?.tasks.map((t) => t.status)).toEqual(['completed', 'pending']);
  });

  it('reads a truncated write the same way', async () => {
    const plans = createPlans({ send: vi.fn() });

    await plans.onTool(fileCall('Write', { truncated: true }));

    expect(plans.get('sess-01')?.source).toBe('plan-file');
  });

  it('a file with no task headings offers nothing', async () => {
    const plans = createPlans({ send: vi.fn() });
    writeFileSync(file, '# Just prose');

    await plans.onTool(fileCall());

    expect(plans.get('sess-01')).toBeUndefined();
  });

  it('a refused read changes nothing and warns once per path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plans = createPlans({ send: vi.fn() });
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'hive-plan-elsewhere-')));

    await plans.onTool(fileCall('Write', { cwd: elsewhere }));
    await plans.onTool(fileCall('Edit', { cwd: elsewhere }));

    expect(plans.get('sess-01')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps a build link across a re-read of the same file', async () => {
    const plans = createPlans({ send: vi.fn() });
    await plans.onTool(fileCall());
    const current = plans.get('sess-01') as SessionPlan;
    plans.offer('sess-01', 'plan-file', { ...current, build: { askId: 'A1', state: 'building' } });

    await plans.onTool(fileCall('Edit'));

    expect(plans.get('sess-01')?.build).toEqual({ askId: 'A1', state: 'building' });
  });

  it("plan mode's plan is offered as proposed tasks", () => {
    const plans = createPlans({ send: vi.fn() });

    void plans.onTool(planMode('1. One\n2. Two'));

    expect(plans.get('sess-01')).toEqual({
      entityId: 'sess-01',
      source: 'plan-mode',
      tasks: [
        { id: '1', title: 'One', status: 'pending' },
        { id: '2', title: 'Two', status: 'pending' },
      ],
      allDone: false,
    });
  });

  it('a plan-mode plan with no tasks, or no plan string, offers nothing', () => {
    const plans = createPlans({ send: vi.fn() });

    void plans.onTool(planMode('Just do it.'));
    void plans.onTool({ ...planMode(''), toolInput: {} });

    expect(plans.get('sess-01')).toBeUndefined();
  });

  it('plan mode, then TaskCreate, ends with the task-tool plan', () => {
    const plans = createPlans({ send: vi.fn() });

    void plans.onTool(planMode('### P'));
    void plans.onTool(create('1', 'A'));

    expect(plans.get('sess-01')?.source).toBe('task-tools');
  });

  it('TaskCreate, then a plan-file write, keeps the task-tool plan', async () => {
    const plans = createPlans({ send: vi.fn() });

    void plans.onTool(create('1', 'A'));
    await plans.onTool(fileCall());

    expect(plans.get('sess-01')?.source).toBe('task-tools');
  });
});
