import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, diffSince, replay, restore } from '../src/index.js';

/** Random edits on a doc (positions taken modulo the current length). */
function edit(d: Doc, e: { ins: boolean; pos: number; s: string; len: number }): void {
  if (e.ins || d.length === 0) d.insert(e.pos % (d.length + 1), e.s);
  else {
    const p = e.pos % d.length;
    d.delete(p, Math.min(e.len, d.length - p));
  }
}

const editArb = fc.record({
  ins: fc.boolean(),
  pos: fc.nat(),
  s: fc.string({ minLength: 1, maxLength: 4 }),
  len: fc.integer({ min: 1, max: 4 }),
});

describe('version history', () => {
  it('replaying a log prefix reproduces every past state', () => {
    const d = new Doc({ agent: 'a' });
    const texts: string[] = [''];
    for (const s of ['hello', ' world', '!']) {
      d.insert(d.length, s);
      d.delete(0, 0);
      texts.push(d.text);
      d.setMeta('n', texts.length); // breaks run-length merging between steps
    }
    const ops = d.getOps();
    expect(replay(ops, 0).text).toBe('');
    expect(replay(ops, ops.length).text).toBe(d.text);
    const seen = ops.map((_, i) => replay(ops, i + 1).text);
    for (const t of texts) expect(seen.concat('')).toContain(t);
  });

  it('diff segments reassemble both versions (200 runs)', () => {
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 1, maxLength: 40, size: 'max' }), fc.nat(), (edits, cut) => {
        const d = new Doc({ agent: 'a' });
        for (const e of edits) edit(d, e);
        const ops = d.getOps();
        const past = replay(ops, cut % (ops.length + 1));
        const segs = diffSince(past, d);
        const then = segs.filter((s) => s.type !== 'inserted').map((s) => s.text).join('');
        const now = segs.filter((s) => s.type !== 'deleted').map((s) => s.text).join('');
        expect(then).toBe(past.text);
        expect(now).toBe(d.text);
      }),
      { numRuns: 200 },
    );
  });

  it('restore produces the past text with new ops only (200 runs)', () => {
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 1, maxLength: 40, size: 'max' }), fc.nat(), (edits, cut) => {
        const d = new Doc({ agent: 'a' });
        for (const e of edits) edit(d, e);
        const before = d.getOps();
        const past = replay(before, cut % (before.length + 1));
        restore(d, past);
        expect(d.text).toBe(past.text);
        // History is append-only: the old log is an untouched prefix.
        expect(d.getOps().slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1));
      }),
      { numRuns: 200 },
    );
  });

  it('a restore converges across two peers, even with concurrent edits (200 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(editArb, { minLength: 1, maxLength: 30, size: 'max' }),
        fc.array(editArb, { maxLength: 10 }),
        fc.nat(),
        (shared, concurrent, cut) => {
          const a = new Doc({ agent: 'a' });
          const b = new Doc({ agent: 'b' });
          shared.forEach((e, i) => {
            edit(i % 2 ? a : b, e);
            if (i % 3 === 0) {
              a.applyRemote(b.getOps(a.version()));
              b.applyRemote(a.getOps(b.version()));
            }
          });
          a.applyRemote(b.getOps(a.version()));
          b.applyRemote(a.getOps(b.version()));

          const ops = a.getOps();
          const past = replay(ops, cut % (ops.length + 1));
          restore(a, past); // a restores ...
          for (const e of concurrent) edit(b, e); // ... while b keeps writing

          a.applyRemote(b.getOps(a.version()));
          b.applyRemote(a.getOps(b.version()));
          expect(a.text).toBe(b.text);
          expect(a.visibleIds()).toEqual(b.visibleIds());
          if (concurrent.length === 0) expect(b.text).toBe(past.text);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('example: restore an earlier draft after a collaborator rewrote it', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'The plan: walk to the castle.');
    const b = new Doc({ agent: 'b' });
    b.applyRemote(a.getOps());
    const draftAt = b.getOps().length;
    b.delete(10, 19);
    b.insert(10, 'take the tram.');
    a.applyRemote(b.getOps(a.version()));
    const segs = diffSince(replay(a.getOps(), draftAt), a);
    expect(segs).toEqual([
      { type: 'same', text: 'The plan: ' },
      { type: 'inserted', text: 'take the tram.' },
      { type: 'deleted', text: 'walk to the castle.' },
    ]);
    restore(a, replay(a.getOps(), draftAt));
    b.applyRemote(a.getOps(b.version()));
    expect(a.text).toBe('The plan: walk to the castle.');
    expect(b.text).toBe(a.text);
  });
});
