/**
 * The README's claim is that our list-based integration (Gentle's YjsMod)
 * orders elements exactly like FugueMax. The Fugue paper only *conjectures*
 * YjsMod == FugueMax (sections 3.1 and 8), so we test it: N replicas run the
 * same random editing and syncing script on both our Doc and a naive,
 * paper-faithful FugueMax tree (test/fuguemax-oracle.ts), and after every
 * step the visible character ids must be identical on every replica.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc } from '../src/index.js';
import { FugueMaxOracle } from './fuguemax-oracle.js';

const RUNS = 1000;

class OracleReplica {
  readonly tree = new FugueMaxOracle();
  readonly deletes = new Set<string>();
  seq = 0;
  constructor(readonly agent: string) {}

  insert(pos: number, text: string): void {
    for (let k = 0; k < text.length; k++) this.tree.insert(pos + k, text[k]!, this.agent, this.seq++);
  }

  delete(pos: number, len: number): void {
    for (let k = 0; k < len; k++) this.deletes.add(this.tree.delete(pos));
    this.seq += len; // Doc spends one seq per deleted char
  }

  receiveFrom(other: OracleReplica): void {
    for (const node of other.tree.delivered) this.tree.deliver(node);
    for (const id of other.deletes) {
      this.deletes.add(id);
      this.tree.deleteById(id);
    }
  }
}

describe('YjsMod integration agrees with a paper-faithful FugueMax', () => {
  it(`random concurrent editing on 2-4 replicas (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(
          fc.oneof(
            { weight: 6, arbitrary: fc.record({ t: fc.constant('ins' as const), r: fc.nat(), pos: fc.nat(), s: fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 3 }) }) },
            { weight: 2, arbitrary: fc.record({ t: fc.constant('del' as const), r: fc.nat(), pos: fc.nat(), len: fc.integer({ min: 1, max: 3 }) }) },
            { weight: 3, arbitrary: fc.record({ t: fc.constant('sync' as const), from: fc.nat(), to: fc.nat() }) },
          ),
          { minLength: 5, maxLength: 60, size: 'max' },
        ),
        (n, steps) => {
          const docs = Array.from({ length: n }, (_, i) => new Doc({ agent: `r${i}` }));
          const oracles = Array.from({ length: n }, (_, i) => new OracleReplica(`r${i}`));
          for (const s of steps) {
            if (s.t === 'sync') {
              const from = s.from % n;
              const to = s.to % n;
              if (from === to) continue;
              docs[to]!.applyRemote(docs[from]!.getOps(docs[to]!.version()));
              oracles[to]!.receiveFrom(oracles[from]!);
              expect(docs[to]!.visibleIds()).toEqual(oracles[to]!.tree.visibleIds());
              continue;
            }
            const d = docs[s.r % n]!;
            const o = oracles[s.r % n]!;
            if (s.t === 'ins') {
              const pos = s.pos % (d.length + 1);
              d.insert(pos, s.s);
              o.insert(pos, s.s);
            } else if (d.length > 0) {
              const pos = s.pos % d.length;
              const len = Math.min(s.len, d.length - pos);
              d.delete(pos, len);
              o.delete(pos, len);
            }
            expect(d.visibleIds()).toEqual(o.tree.visibleIds());
          }
          // Full mesh sync, then everything must agree.
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              docs[j]!.applyRemote(docs[i]!.getOps(docs[j]!.version()));
              oracles[j]!.receiveFrom(oracles[i]!);
            }
          }
          for (let i = 0; i < n; i++) {
            expect(docs[i]!.visibleIds()).toEqual(oracles[i]!.tree.visibleIds());
            expect(docs[i]!.text).toBe(oracles[i]!.tree.text());
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('the Figure 7/8 execution where Fugue and FugueMax differ yields AXYBC', () => {
    // Three replicas concurrently insert A, B, C into an empty list (IDs
    // ordered A < B < C). Replica 1 sees {A, C} and inserts X between them;
    // replica 2 sees {A, B} and inserts Y between them. The paper shows the
    // only maximally non-interleaving order is A X Y B C (section 5.3).
    const ra = new Doc({ agent: 'a' });
    const rb = new Doc({ agent: 'b' });
    const rc = new Doc({ agent: 'c' });
    ra.insert(0, 'A');
    rb.insert(0, 'B');
    rc.insert(0, 'C');

    const r1 = new Doc({ agent: 'x' });
    r1.applyRemote([...ra.getOps(), ...rc.getOps()]);
    expect(r1.text).toBe('AC');
    r1.insert(1, 'X');

    const r2 = new Doc({ agent: 'y' });
    r2.applyRemote([...ra.getOps(), ...rb.getOps()]);
    expect(r2.text).toBe('AB');
    r2.insert(1, 'Y');

    const merged = new Doc({ agent: 'z' });
    merged.applyRemote([...ra.getOps(), ...rb.getOps(), ...rc.getOps(), ...r1.getOps(), ...r2.getOps()]);
    expect(merged.text).toBe('AXYBC');
  });
});
