import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlans, type PlanToolCall } from '../../../../electron/main/plans';
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
