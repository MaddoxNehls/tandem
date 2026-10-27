import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, MoveTree, ROOT, TRASH, type Op } from '../src/index.js';
import { assertAcyclic, NODES, PARENTS, rng, shuffle } from './helpers.js';

describe('movable tree', () => {
  it('creates, moves and deletes pages', () => {
    const d = new Doc({ agent: 'a' });
    d.movePage('a');
    d.movePage('b', 'a');
    d.movePage('c', 'b');
    expect(d.pageChildren()).toEqual(['a']);
    expect(d.pageChildren('a')).toEqual(['b']);
    d.movePage('c', ROOT);
    expect(d.pageChildren()).toEqual(['a', 'c']);
    d.deletePage('a');
    expect(d.isPageLive('a')).toBe(false);
    expect(d.isPageLive('b')).toBe(false); // the subtree goes with it
    expect(d.isPageLive('c')).toBe(true);
    expect(() => d.movePage(ROOT, 'a')).toThrow(RangeError);
  });

  it('refuses a local move that would create a cycle', () => {
    const d = new Doc({ agent: 'a' });
    d.movePage('a');
    d.movePage('b', 'a');
    expect(d.movePage('a', 'b')).toBe(false);
    expect(d.movePage('a', 'a')).toBe(false);
    expect(d.getOps()).toHaveLength(2);
  });

  it('concurrent A-under-B and B-under-A does not create a cycle', () => {
    const r1 = new Doc({ agent: 'r1' });
    r1.movePage('A');
    r1.movePage('B');
    const r2 = new Doc({ agent: 'r2' });
    r2.applyRemote(r1.getOps());
    r1.movePage('A', 'B');
    r2.movePage('B', 'A');
    r1.applyRemote(r2.getOps(r1.version()));
    r2.applyRemote(r1.getOps(r2.version()));
    assertAcyclic(r1);
    expect(r1.pages()).toEqual(r2.pages());
    // Both moves have lamport 2; 'r2' > 'r1', so B-under-A is ordered last
    // and skipped because by then A is already under B.
    expect(r1.pageParent('A')).toBe('B');
    expect(r1.pageParent('B')).toBe(ROOT);
  });

  it('concurrent moves of the same node: the later timestamp wins', () => {
    const r1 = new Doc({ agent: 'r1' });
    r1.movePage('X');
    r1.movePage('P');
    r1.movePage('Q');
    const r2 = new Doc({ agent: 'r2' });
    r2.applyRemote(r1.getOps());
    r1.movePage('X', 'P');
    r2.movePage('X', 'Q');
    r1.applyRemote(r2.getOps(r1.version()));
    r2.applyRemote(r1.getOps(r2.version()));
    expect(r1.pageParent('X')).toBe('Q');
    expect(r2.pageParent('X')).toBe('Q');
  });

  it('undo/redo re-evaluates later moves when an earlier one arrives late', () => {
    const t = new MoveTree();
    t.apply(5, 'a', 'x', 'p'); // x under p
    t.apply(7, 'a', 'p', 'x'); // p under x: would be a cycle, skipped
    expect(t.parentOf('p')).toBeUndefined();
    expect(t.parentOf('x')).toBe('p');
    // A move with an earlier timestamp arrives: it is slotted in before
    // both, and the later moves are redone on top of it.
    t.apply(1, 'a', 'p', ROOT);
    expect(t.parentOf('p')).toBe(ROOT);
    expect(t.parentOf('x')).toBe('p');
    expect(t.logLength).toBe(3);
  });

  it('never has cycles and converges under random concurrent moves (400 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.record({ r: fc.nat(), node: fc.nat(), parent: fc.nat(), sync: fc.nat(9) }), {
          minLength: 5,
          maxLength: 80,
          size: 'max',
        }),
        fc.integer(),
        (n, moves, seed) => {
          const docs = Array.from({ length: n }, (_, i) => new Doc({ agent: `r${i}` }));
          const rand = rng(seed);
          for (const m of moves) {
            const d = docs[m.r % n]!;
            d.movePage(NODES[m.node % NODES.length]!, PARENTS[m.parent % PARENTS.length]!);
            if (m.sync === 0) {
              const to = docs[Math.floor(rand() * n)]!;
              to.applyRemote(shuffle(d.getOps(), rand));
              assertAcyclic(to);
            }
          }
          const all: Op[] = docs.flatMap((d) => d.getOps());
          for (const d of docs) {
            for (const op of shuffle(all.slice(), rand)) {
              d.applyRemote([op]);
              assertAcyclic(d);
            }
          }
          for (const d of docs.slice(1)) expect(d.pages()).toEqual(docs[0]!.pages());
          for (const node of NODES) {
            const p = docs[0]!.pageParent(node);
            if (p !== undefined) expect(p === ROOT || p === TRASH || NODES.includes(p)).toBe(true);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
