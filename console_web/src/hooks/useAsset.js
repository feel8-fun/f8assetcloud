import { useEffect, useRef, useState } from 'react';

import { getAssetDetail, getAssetVersionContent, listAssetVersions, resolveAsset } from '../lib/api.js';

export function useAsset(assetId) {
  const [assetType, setAssetType] = useState('');
  const [asset, setAsset] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionContentByNumber, setVersionContentByNumber] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestOwner = useRef(null);

  useEffect(() => {
    const current = { assetId, assetType: '', content: {}, pending: new Map() };
    requestOwner.current = current;
    setAssetType('');
    setAsset(null);
    setVersions([]);
    setVersionContentByNumber({});
    setLoading(false);
    if (!assetId) {
      setAssetType('');
      setAsset(null);
      setVersions([]);
      setVersionContentByNumber({});
      setError('');
      return undefined;
    }
    setLoading(true);
    setError('');
    setVersionContentByNumber({});
    void (async () => {
      try {
        const resolved = await resolveAsset(assetId);
        const resolvedType = String(resolved?.assetType || '');
        if (requestOwner.current !== current) return;
        const [detail, versionPage] = await Promise.all([
          getAssetDetail(resolvedType, assetId),
          listAssetVersions(resolvedType, assetId),
        ]);
        if (requestOwner.current !== current) {
          return;
        }
        setAssetType(resolvedType);
        current.assetType = resolvedType;
        setAsset(detail);
        setVersions(Array.isArray(versionPage?.versions) ? versionPage.versions : []);
      } catch (errorValue) {
        if (requestOwner.current !== current) {
          return;
        }
        setAssetType('');
        setAsset(null);
        setVersions([]);
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      } finally {
        if (requestOwner.current === current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      if (requestOwner.current === current) requestOwner.current = null;
    };
  }, [assetId]);

  async function loadVersionContent(versionNumber) {
    const key = String(versionNumber);
    const current = requestOwner.current;
    if (!current?.assetType || current.assetId !== assetId) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(current.content, key)) {
      return current.content[key];
    }
    if (current.pending.has(key)) return current.pending.get(key);
    const pending = getAssetVersionContent(current.assetType, assetId, versionNumber).then((payload) => {
      if (requestOwner.current !== current) return null;
      current.content[key] = payload;
      setVersionContentByNumber({ ...current.content });
      return payload;
    }).finally(() => current.pending.delete(key));
    current.pending.set(key, pending);
    return pending;
  }

  return {
    asset,
    assetType,
    error,
    loadVersionContent,
    loading,
    setAsset,
    setVersions,
    versionContentByNumber,
    versions,
  };
}
