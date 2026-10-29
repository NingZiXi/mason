export interface StlCacheEntry<G extends { dispose(): void }> {
  bytes: ArrayBuffer;
  paramsHash: string;
  geometry?: G;
}

export function cacheStlPart<G extends { dispose(): void }>(
  entries: Record<string, StlCacheEntry<G>>, part: string, bytes: ArrayBuffer, paramsHash: string, replaceSameHash = false,
): Record<string, StlCacheEntry<G>> {
  const previous = entries[part];
  // A duplicate preload must keep the geometry already used by the foreground.
  if (previous?.paramsHash === paramsHash && !replaceSameHash) return entries;
  previous?.geometry?.dispose();
  return { ...entries, [part]: { bytes, paramsHash } };
}

export function clearStlCache<G extends { dispose(): void }>(entries: Record<string, StlCacheEntry<G>>) {
  const geometries = new Set(Object.values(entries).flatMap(entry => entry.geometry ? [entry.geometry] : []));
  geometries.forEach(geometry => geometry.dispose());
}
