import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { listAssets } = vi.hoisted(() => ({ listAssets: vi.fn() }));
vi.mock('../lib/api.js', () => ({ listAssets }));
import { useAssets } from './useAssets.js';
afterEach(cleanup);
beforeEach(() => { listAssets.mockReset(); });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
it('paginates both types, deduplicates, and prevents concurrent page requests', async () => {
  const more = deferred();
  listAssets.mockImplementation((type, options) => options.cursor ? more.promise : Promise.resolve({ entries: [{ assetType: type, assetId: type, updatedAt: '2026-01-01' }], nextCursor: type === 'component' ? 'c2' : null }));
  const { result } = renderHook(() => useAssets({}));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.entries).toHaveLength(2);
  expect(result.current.hasMore).toBe(true);
  let pending;
  act(() => { pending = result.current.loadMore(); void result.current.loadMore(); });
  expect(listAssets).toHaveBeenCalledTimes(3);
  await act(async () => { more.resolve({ entries: [{ assetType: 'component', assetId: 'component', updatedAt: '2026-02-01' }, { assetType: 'component', assetId: 'new', updatedAt: '2026-03-01' }], nextCursor: null }); await pending; });
  expect(result.current.entries.map(e => e.assetId)).toEqual(['new', 'component', 'variant']);
  expect(result.current.hasMore).toBe(false);
});
it('ignores an old page after query and owner change', async () => {
  const old = deferred();
  listAssets.mockImplementation((_type, options) => options.cursor ? old.promise : Promise.resolve({ entries: [{ assetId: options.owner, assetType: 'component' }], nextCursor: 'next' }));
  const { result, rerender } = renderHook(({ owner }) => useAssets({ owner, initialType: 'component' }), { initialProps: { owner: 'old' } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let pending;
  act(() => { pending = result.current.loadMore(); });
  rerender({ owner: 'new' });
  await waitFor(() => expect(result.current.entries[0]?.assetId).toBe('new'));
  await act(async () => { old.resolve({ entries: [{ assetId: 'stale' }], nextCursor: null }); await pending; });
  expect(result.current.entries.map(e => e.assetId)).toEqual(['new']);
  expect(result.current.loadingMore).toBe(false);
});
