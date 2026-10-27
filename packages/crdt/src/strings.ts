/**
 * Appending to a string one keystroke at a time is the hot path of a text
 * editor. In V8 (and other engines) `a + b` builds a rope node ("cons
 * string") instead of copying, which is fast but costs ~20-32 bytes per
 * append until something flattens the rope. For a 180k-character trace that
 * is several MB of rope nodes, twice over (spans and the op log).
 *
 * `appendFlattening` appends and, once the number of appends since the last
 * flatten exceeds max(16, length / 16), copies the string into a flat one.
 * Each flatten costs O(length) and happens every ~length/16 appends, so the
 * amortized cost is O(16) per append while rope overhead stays bounded at
 * roughly 2 bytes per character. Semantically this is a no-op.
 */
export function appendFlattening(base: string, add: string, appendsSoFar: number): [string, number] {
  const s = base + add;
  const n = appendsSoFar + 1;
  if (n > 16 && n > s.length >>> 4) return [flatten(s), 0];
  return [s, n];
}

/** Force a flat copy (slicing a fresh concatenation flattens it in V8). */
export function flatten(s: string): string {
  return (' ' + s).slice(1);
}
