/**
 * Property: N replicas (2-5) make random interleaved edits to text, metadata
 * and the page tree while exchanging ops over a network that drops,
 * duplicates, reorders and partitions messages. After the partitions heal
 * and replicas sync, all replicas must be identical, and:
 *   - every local edit had exactly the effect of a plain string splice
 *     (local intention preservation);
 *   - two characters that were ever seen in some order on some replica
 *     appear in that order in the final document (order is never rewritten);
 *   - the page tree was acyclic on every replica after every step;
 *   - the tree / map equal the sequential, timestamp-ordered reference.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, type JsonValue, type MoveOp, type Op, type SetOp } from '../src/index.js';
import { assertAcyclic, assertConverged, Network, NODES, PARENTS, rng } from './helpers.js';

const RUNS = 400;

const text = fc.oneof(
  fc.string({ minLength: 1, maxLength: 6 }),
  // Arbitrary code points, including astral ones (surrogate pairs).
  fc.string({ unit: 'binary', minLength: 1, maxLength: 3 }),
);
const value: fc.Arbitrary<JsonValue | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.string({ maxLength: 4 }),
  fc.array(fc.integer(), { maxLength: 3 }),
);

const step = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('ins' as const), r: fc.nat(), pos: fc.nat(), s: text }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('del' as const), r: fc.nat(), pos: fc.nat(), len: fc.integer({ min: 1, max: 5 }) }) },
  // A run of backspaces, optionally sending a message mid-run so peers see
  // a prefix of what becomes one merged (reversed-range) delete op.
  { weight: 2, arbitrary: fc.record({ t: fc.constant('bs' as const), r: fc.nat(), pos: fc.nat(), count: fc.integer({ min: 2, max: 6 }), sendAt: fc.nat(6), to: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('set' as const), r: fc.nat(), key: fc.constantFrom('title', 'icon', 'tags'), value }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('move' as const), r: fc.nat(), node: fc.nat(), parent: fc.nat() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('send' as const), from: fc.nat(), to: fc.nat(), drop: fc.constantFrom(0, 0.3, 0.7), stale: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('deliver' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('partition' as const), mask: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('heal' as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('snapshot' as const), r: fc.nat() }) },
);

/** Reference semantics for the tree: apply moves sequentially in ts order. */
function referenceTree(moves: MoveOp[]): [string, string][] {
  const sorted = moves.slice().sort((a, b) => a.lamport - b.lamport || (a.agent < b.agent ? -1 : 1));
  const parent = new Map<string, string>();
  const isAncestor = (anc: string, n: string): boolean => {
    for (let p: string | undefined = n; p !== undefined; p = parent.get(p)) if (p === anc) return true;
    return false;
  };
  for (const m of sorted) if (!isAncestor(m.node, m.parent)) parent.set(m.node, m.parent);
  return [...parent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function referenceMap(sets: SetOp[]): Record<string, JsonValue> {
  const best = new Map<string, SetOp>();
  for (const s of sets) {
    const cur = best.get(s.key);
    if (!cur || s.lamport > cur.lamport || (s.lamport === cur.lamport && s.agent > cur.agent)) best.set(s.key, s);
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, s] of [...best].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (s.value !== undefined) out[k] = s.value;
  return out;
}

describe('convergence under adversarial delivery', () => {
  it(`N=2..5 replicas converge with drops, duplicates, reordering and partitions (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(step, { minLength: 20, maxLength: 150, size: 'max' }),
        fc.integer(),
        (n, steps, seed) => {
          const docs = Array.from({ length: n }, (_, i) => new Doc({ agent: `agent${i}` }));
          const net = new Network(docs, rng(seed));
          const snapshots: string[][] = [];

          for (const s of steps) {
            switch (s.t) {
              case 'ins': {
                const d = docs[s.r % n]!;
                const before = d.text;
                const pos = s.pos % (before.length + 1);
                d.insert(pos, s.s);
                expect(d.text).toBe(before.slice(0, pos) + s.s + before.slice(pos));
                break;
              }
              case 'del': {
                const d = docs[s.r % n]!;
                const before = d.text;
                if (before.length === 0) break;
                const pos = s.pos % before.length;
                const len = Math.min(s.len, before.length - pos);
                d.delete(pos, len);
                expect(d.text).toBe(before.slice(0, pos) + before.slice(pos + len));
                break;
              }
              case 'bs': {
                const d = docs[s.r % n]!;
                let cursor = (s.pos % (d.length + 1));
                for (let k = 0; k < s.count && cursor > 0; k++) {
                  const before = d.text;
                  d.delete(cursor - 1, 1);
                  cursor--;
                  expect(d.text).toBe(before.slice(0, cursor) + before.slice(cursor + 1));
                  if (k === s.sendAt) net.send(s.r % n, s.to % n, 0, false);
                }
                break;
              }
              case 'set': {
                const d = docs[s.r % n]!;
                d.setMeta(s.key, s.value);
                expect(d.getMeta(s.key)).toEqual(s.value);
                break;
              }
              case 'move': {
                const d = docs[s.r % n]!;
                const node = NODES[s.node % NODES.length]!;
                const parent = PARENTS[s.parent % PARENTS.length]!;
                if (d.movePage(node, parent)) expect(d.pageParent(node)).toBe(parent);
                break;
              }
              case 'send':
                net.send(s.from % n, s.to % n, s.drop, s.stale);
                break;
              case 'deliver':
                net.deliver(s.pick);
                break;
              case 'partition':
                net.group = docs.map((_, i) => (s.mask >> i) & 1);
                break;
              case 'heal':
                net.group = null;
                break;
              case 'snapshot':
                snapshots.push(docs[s.r % n]!.visibleIds());
                break;
            }
            for (const d of docs) assertAcyclic(d);
          }

          net.settle();
          assertConverged(docs);

          // Established order is never changed by later merges.
          const finalIds = docs[0]!.visibleIds();
          const index = new Map(finalIds.map((id, i) => [id, i]));
          for (const snap of snapshots) {
            let last = -1;
            for (const id of snap) {
              const i = index.get(id);
              if (i === undefined) continue; // deleted since
              expect(i).toBeGreaterThan(last);
              last = i;
            }
          }

          // Map and tree equal their sequential reference semantics.
          const all: Op[] = docs[0]!.getOps();
          expect(docs[0]!.meta()).toEqual(referenceMap(all.filter((o): o is SetOp => o.kind === 'set')));
          expect(docs[0]!.pages()).toEqual(referenceTree(all.filter((o): o is MoveOp => o.kind === 'move')));

          // A snapshot round-trips to the same state.
          const loaded = Doc.load(docs[0]!.save(), { agent: 'loader' });
          expect(loaded.text).toBe(docs[0]!.text);
          expect(loaded.visibleIds()).toEqual(finalIds);
          expect(loaded.meta()).toEqual(docs[0]!.meta());
          expect(loaded.pages()).toEqual(docs[0]!.pages());
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('idempotence and commutativity', () => {
  const edits = fc.array(
    fc.record({ r: fc.nat(), kind: fc.nat(3), pos: fc.nat(), s: text, len: fc.integer({ min: 1, max: 4 }) }),
    { minLength: 5, maxLength: 60, size: 'max' },
  );

  /** Concurrent edits on n replicas that only occasionally sync. */
  function concurrentOps(n: number, script: { r: number; kind: number; pos: number; s: string; len: number }[]): Op[] {
    const docs = Array.from({ length: n }, (_, i) => new Doc({ agent: `r${i}` }));
    script.forEach((e, i) => {
      const d = docs[e.r % n]!;
      if (e.kind === 0 || d.length === 0) d.insert(e.pos % (d.length + 1), e.s);
      else if (e.kind === 1) d.delete(e.pos % d.length, Math.min(e.len, d.length - (e.pos % d.length)));
      else if (e.kind === 2) d.setMeta('k', e.pos);
      else d.movePage(NODES[e.pos % NODES.length]!, PARENTS[e.len % PARENTS.length]!);
      if (i % 7 === 6) {
        const other = docs[(e.r + 1) % n]!;
        other.applyRemote(d.getOps(other.version()));
      }
    });
    const merged = new Doc({ agent: 'merge' });
    for (const d of docs) merged.applyRemote(d.getOps());
    return merged.getOps();
  }

  it('applying any ops twice equals applying them once (300 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), edits, fc.integer(), (n, script, seed) => {
        const ops = concurrentOps(n, script);
        const once = new Doc({ agent: 'x' });
        once.applyRemote(ops);
        const twice = new Doc({ agent: 'x' });
        twice.applyRemote(ops);
        const again = twice.applyRemote(ops.slice().reverse());
        expect(again.applied).toBe(0);
        expect(again.duplicates).toBe(ops.length);
        // Also re-deliver a random subset of already-applied ops.
        const r = rng(seed);
        twice.applyRemote(ops.filter(() => r() < 0.5));
        expect(twice.text).toBe(once.text);
        expect(twice.visibleIds()).toEqual(once.visibleIds());
        expect(twice.version()).toEqual(once.version());
      }),
      { numRuns: 300 },
    );
  });

  it('any delivery permutation yields the same state (300 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }), edits, fc.integer(), fc.integer(), (n, script, s1, s2) => {
        const ops = concurrentOps(n, script);
        const a = new Doc({ agent: 'x' });
        const b = new Doc({ agent: 'y' });
        // Deliver one op at a time, in two different random orders, so the
        // causal buffer has to hold and release ops.
        for (const op of shuffleCopy(ops, s1)) a.applyRemote([op]);
        for (const op of shuffleCopy(ops, s2)) b.applyRemote([op]);
        expect(a.pending).toBe(0);
        expect(b.pending).toBe(0);
        expect(a.text).toBe(b.text);
        expect(a.visibleIds()).toEqual(b.visibleIds());
        expect(a.meta()).toEqual(b.meta());
        expect(a.pages()).toEqual(b.pages());
      }),
      { numRuns: 300 },
    );
  });
});

function shuffleCopy<T>(arr: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
