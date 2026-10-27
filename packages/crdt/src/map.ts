/**
 * Last-writer-wins map: one LWW register per key.
 *
 * Each write carries a timestamp (lamport, agent). A write replaces the
 * current value iff its timestamp is greater in the total order
 *   (l1, a1) < (l2, a2)  <=>  l1 < l2 || (l1 === l2 && a1 < a2).
 * Lamport clocks guarantee that a write which causally follows another has a
 * larger timestamp, so a replica that saw the old value and overwrote it
 * always wins. Concurrent writes get an arbitrary but deterministic winner
 * (the agent-id tiebreak). Because "take the max" is commutative,
 * associative and idempotent, replicas converge regardless of delivery order.
 *
 * Deletion is a write of `undefined` (a tombstone), so a delete and a
 * concurrent set are ordered by the same rule.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Register {
  value: JsonValue | undefined;
  lamport: number;
  agent: string;
}

export function timestampGreater(l1: number, a1: string, l2: number, a2: string): boolean {
  return l1 > l2 || (l1 === l2 && a1 > a2);
}

export class LWWMap {
  private readonly regs = new Map<string, Register>();

  /** Apply a write; returns true if it became the visible value. */
  apply(key: string, value: JsonValue | undefined, lamport: number, agent: string): boolean {
    const cur = this.regs.get(key);
    if (cur && !timestampGreater(lamport, agent, cur.lamport, cur.agent)) return false;
    this.regs.set(key, { value, lamport, agent });
    return true;
  }

  get(key: string): JsonValue | undefined {
    return this.regs.get(key)?.value;
  }

  /** Live (non-deleted) entries, sorted by key for deterministic output. */
  entries(): [string, JsonValue][] {
    const out: [string, JsonValue][] = [];
    for (const [k, r] of this.regs) if (r.value !== undefined) out.push([k, r.value]);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  toJSON(): Record<string, JsonValue> {
    return Object.fromEntries(this.entries());
  }
}
