import { useEffect, useRef, useState } from 'react';

import { listAssets } from '../lib/api.js';

function mergeAssetEntries(pages) {
  const entries = pages.flatMap((page) => Array.isArray(page?.entries) ? page.entries : []);
  return [...new Map(entries.map((entry) => [
    `${entry.assetType}:${entry.assetId || entry.componentId || entry.variantId}`, entry,
  ])).values()]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export function useAssets({ owner = '', initialType = 'all', initialQuery = '' }) {
  const [assetType, setAssetType] = useState(initialType);
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState([]);
  const [cursors, setCursors] = useState({});
  const requestOwner = useRef(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const current = { owner, assetType, query, cursors: {}, loadingMore: false };
    requestOwner.current = current;
    async function loadInitial() {
      setLoading(true);
      setLoadingMore(false);
      setEntries([]);
      setCursors({});
      setError('');
      try {
        const types = assetType === 'all' ? ['component', 'variant'] : [assetType];
        const pages = await Promise.all(types.map((type) => listAssets(type, {
          owner,
          q: query,
        })));
        if (requestOwner.current !== current) {
          return;
        }
        setEntries(mergeAssetEntries(pages));
        current.cursors = Object.fromEntries(types.map((type, index) => [type, pages[index]?.nextCursor || null]));
        setCursors(current.cursors);
      } catch (errorValue) {
        if (requestOwner.current !== current) {
          return;
        }
        setEntries([]);
        setCursors({});
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      } finally {
        if (requestOwner.current === current) {
          setLoading(false);
        }
      }
    }
    void loadInitial();
    return () => {
      if (requestOwner.current === current) requestOwner.current = null;
    };
  }, [assetType, owner, query]);

  async function loadMore() {
    const current = requestOwner.current;
    if (!current || current.owner !== owner || current.assetType !== assetType || current.query !== query || current.loadingMore) {
      return;
    }
    const types = Object.keys(current.cursors).filter((type) => current.cursors[type]);
    if (types.length === 0) return;
    current.loadingMore = true;
    setLoadingMore(true);
    setError('');
    try {
      const pages = await Promise.all(types.map((type) => listAssets(type, {
        owner,
        q: query,
        cursor: current.cursors[type],
      })));
      if (requestOwner.current !== current) return;
      setEntries((previous) => mergeAssetEntries([{ entries: previous }, ...pages]));
      current.cursors = { ...current.cursors, ...Object.fromEntries(types.map((type, index) => [type, pages[index]?.nextCursor || null])) };
      setCursors(current.cursors);
    } catch (errorValue) {
      if (requestOwner.current === current) setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      current.loadingMore = false;
      if (requestOwner.current === current) setLoadingMore(false);
    }
  }

  return {
    assetType,
    entries,
    error,
    hasMore: Object.values(cursors).some(Boolean),
    loading,
    loadingMore,
    loadMore,
    query,
    refreshKey: `${owner}:${assetType}:${query}`,
    setAssetType,
    setEntries,
    setQuery,
  };
}
