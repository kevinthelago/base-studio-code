// Pure, non-mutating immutable-update helpers for the Zustand slices (#1704).
//
// The slices repeat the same immutable idioms hundreds of times — `{ ...map, [key]: val }` to set a
// record entry, `const n = { ...map }; delete n[key]` to drop one, and `arr.map((x, i) => i === idx
// ? { ...x, ...patch } : x)` to patch one array item. These helpers name those idioms so the call
// sites read by intent. Each returns a NEW value and never mutates its argument, so they're safe to
// use directly inside a Zustand `set((s) => …)` updater.

/** Return a NEW record with `key` set to `value`; the input map is not mutated. */
export function setMapEntry<K extends PropertyKey, V>(
  map: Record<K, V>,
  key: K,
  value: V,
): Record<K, V> {
  return { ...map, [key]: value } as Record<K, V>;
}

/** Return a NEW record with `key` removed; the input map is not mutated. A missing key is a no-op. */
export function deleteMapEntry<K extends PropertyKey, V>(
  map: Record<K, V>,
  key: K,
): Record<K, V> {
  const next: Record<K, V> = { ...map };
  delete (next as Partial<Record<K, V>>)[key];
  return next;
}

/** Return a NEW record with every key in `keys` removed; the input map is not mutated. Missing keys
 *  are no-ops. */
export function deleteMapEntries<K extends PropertyKey, V>(
  map: Record<K, V>,
  keys: Iterable<K>,
): Record<K, V> {
  const next: Record<K, V> = { ...map };
  for (const key of keys) delete (next as Partial<Record<K, V>>)[key];
  return next;
}

/** Return a NEW array with the item at `index` shallow-merged with `patch`; the input array is not
 *  mutated. An out-of-range index leaves the array unchanged (a fresh copy with identical items). */
export function updateArrayItem<T extends object>(
  arr: T[],
  index: number,
  patch: Partial<T>,
): T[] {
  return arr.map((item, i) => (i === index ? { ...item, ...patch } : item));
}
