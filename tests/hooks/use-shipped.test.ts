import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadShipped, resetShippedState } from '@/lib/shipped';

import { useShipped } from '@hooks/use-shipped';

import { shippedStatus } from '../support/shipped';

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  resetShippedState();
});

describe('useShipped', () => {
  it('maps the changed agents or skills of one kind by name, and leaves out the rest', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      shipped: {
        status: () =>
          Promise.resolve([
            shippedStatus({ name: 'builder', customised: [{ path: 'model', yours: 'haiku', shipped: 'opus' }] }),
            shippedStatus({ name: 'acr' }),
            shippedStatus({ kind: 'skills', name: 'tdd', bodyEdited: true }),
          ]),
      },
    };
    const { result } = renderHook(() => useShipped('agents'));

    await act(() => loadShipped());

    expect([...result.current.keys()]).toEqual(['builder']);
  });

  it('is empty before anything has been read', () => {
    expect(renderHook(() => useShipped('skills')).result.current.size).toBe(0);
  });
});
