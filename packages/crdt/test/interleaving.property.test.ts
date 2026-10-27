/**
 * Fugue's headline guarantee: when several users concurrently type runs of
 * text at the same position, the runs are never interleaved character by
 * character. This must hold whether each user types forwards (each char
 * after the previous one) or backwards (each char before the previous one,
 * e.g. typing with the cursor moved left each time), and for any delivery
 * order.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, type Op } from '../src/index.js';
import { rng, shuffle, syncAll } from './helpers.js';

const RUNS = 500;

function typeRun(doc: Doc, pos: number, word: string, forwards: boolean): void {
  if (forwards) {
    for (let k = 0; k < word.length; k++) doc.insert(pos + k, word[k]!);
  } else {
    for (let k = word.length - 1; k >= 0; k--) doc.insert(pos, word[k]!);
  }
}

describe('non-interleaving of concurrent runs (Fugue)', () => {
  it(`concurrent forward/backward runs at one position stay contiguous (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.string({ maxLength: 8 }),
        fc.nat(),
        fc.array(
          fc.record({
            word: fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 8 }),
            forwards: fc.boolean(),
          }),
          { minLength: 5, maxLength: 5 },
        ),
        fc.integer(),
        (n, base, posSeed, plans, seed) => {
          const docs = Array.from({ length: n }, (_, i) => new Doc({ agent: `user${i}` }));
          if (base.length > 0) docs[0]!.insert(0, base);
          syncAll(docs);
          const pos = posSeed % (base.length + 1);

          const runIds: string[][] = [];
          docs.forEach((d, r) => {
            const plan = plans[r]!;
            const before = new Set(d.visibleIds());
            typeRun(d, pos, plan.word, plan.forwards);
            runIds.push(d.visibleIds().filter((id) => !before.has(id)));
          });

          // Deliver every op to every replica, one at a time, shuffled.
          const all: Op[] = docs.flatMap((d) => d.getOps());
          const rand = rng(seed);
          for (const d of docs) for (const op of shuffle(all.slice(), rand)) d.applyRemote([op]);

          const final = docs[0]!.visibleIds();
          for (const d of docs) expect(d.visibleIds()).toEqual(final);

          const text = docs[0]!.text;
          runIds.forEach((ids, r) => {
            const start = final.indexOf(ids[0]!);
            // Contiguous and in typing order.
            expect(final.slice(start, start + ids.length)).toEqual(ids);
            expect(text).toContain(plans[r]!.word);
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('example from the paper: "milk" and "eggs" typed concurrently', () => {
    const alice = new Doc({ agent: 'alice' });
    alice.insert(0, 'Shopping:\n');
    const bob = new Doc({ agent: 'bob' });
    bob.applyRemote(alice.getOps());

    typeRun(alice, 10, 'milk\n', true);
    typeRun(bob, 10, 'eggs\n', true);
    alice.applyRemote(bob.getOps(alice.version()));
    bob.applyRemote(alice.getOps(bob.version()));

    expect(alice.text).toBe(bob.text);
    expect(['Shopping:\nmilk\neggs\n', 'Shopping:\neggs\nmilk\n']).toContain(alice.text);
  });

  it('backward typing does not interleave (the case where RGA interleaves)', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    a.insert(0, '[]');
    b.applyRemote(a.getOps());
    typeRun(a, 1, 'abc', false); // types c, then b before it, then a
    typeRun(b, 1, 'xyz', false);
    a.applyRemote(b.getOps(a.version()));
    b.applyRemote(a.getOps(b.version()));
    expect(a.text).toBe(b.text);
    expect(['[abcxyz]', '[xyzabc]']).toContain(a.text);
  });
});
