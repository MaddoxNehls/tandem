import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc } from '../src/index.js';
import { rng } from './helpers.js';

describe('text: local edits', () => {
  it('inserts at start, middle and end', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'world');
    d.insert(0, 'hello ');
    d.insert(d.length, '!');
    d.insert(5, ',');
    expect(d.text).toBe('hello, world!');
    expect(d.length).toBe(13);
  });

  it('deletes ranges spanning several spans', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'abc');
    d.insert(3, 'def');
    d.insert(0, 'XYZ');
    d.delete(2, 5); // removes Z a b c d
    expect(d.text).toBe('XYef');
    d.delete(0, d.length);
    expect(d.text).toBe('');
    expect(d.length).toBe(0);
  });

  it('inserts next to tombstones', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'abcdef');
    d.delete(2, 2); // "cd" becomes tombstones
    d.insert(2, 'XY');
    expect(d.text).toBe('abXYef');
    d.delete(0, 6);
    d.insert(0, 'new');
    expect(d.text).toBe('new');
  });

  it('empty insert and zero-length delete are no-ops that still validate', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, '');
    d.delete(0, 0);
    expect(d.getOps()).toEqual([]);
    expect(() => d.insert(1, '')).toThrow(RangeError);
  });

  it('rejects out-of-range positions', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'abc');
    expect(() => d.insert(4, 'x')).toThrow(RangeError);
    expect(() => d.insert(-1, 'x')).toThrow(RangeError);
    expect(() => d.insert(1.5, 'x')).toThrow(RangeError);
    expect(() => d.delete(2, 2)).toThrow(RangeError);
    expect(() => d.delete(-1, 1)).toThrow(RangeError);
    expect(d.text).toBe('abc');
  });

  it('handles astral characters, including splitting a surrogate pair', () => {
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'a\u{1F600}b'); // the emoji is 2 UTF-16 code units
    expect(d.length).toBe(4);
    d.insert(2, '|'); // between the two halves
    expect(d.text).toBe('a\uD83D|\uDE00b');
    expect(Doc.load(d.save()).text).toBe(d.text);
    d.delete(2, 1);
    expect(d.text).toBe('a\u{1F600}b');
  });

  it('typing forwards run-length encodes into one span and one op', () => {
    const d = new Doc({ agent: 'a' });
    for (const ch of 'hello world') d.insert(d.length, ch);
    expect(d.stats().spans).toBe(1);
    expect(d.getOps()).toHaveLength(1);
    // Repeated backspaces merge into one delete op; tombstones re-coalesce.
    for (let i = 0; i < 5; i++) d.delete(d.length - 1, 1);
    expect(d.text).toBe('hello ');
    expect(d.getOps()).toHaveLength(2);
    expect(d.stats().spans).toBe(2);
  });

  it('matches a plain-string model over long random edit sequences (B-tree stress, 60 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ins: fc.boolean(),
            pos: fc.nat(),
            s: fc.string({ minLength: 1, maxLength: 4 }),
            len: fc.integer({ min: 1, max: 8 }),
          }),
          { minLength: 500, maxLength: 3000, size: 'max' },
        ),
        (edits) => {
          const d = new Doc({ agent: 'a' });
          let model = '';
          for (const e of edits) {
            if (e.ins || model.length === 0) {
              const p = e.pos % (model.length + 1);
              d.insert(p, e.s);
              model = model.slice(0, p) + e.s + model.slice(p);
            } else {
              const p = e.pos % model.length;
              const len = Math.min(e.len, model.length - p);
              d.delete(p, len);
              model = model.slice(0, p) + model.slice(p + len);
            }
          }
          expect(d.text).toBe(model);
          expect(d.length).toBe(model.length);
          // A replica that receives the ops remotely builds the same list.
          const r = new Doc({ agent: 'b' });
          r.applyRemote(d.getOps());
          expect(r.visibleIds()).toEqual(d.visibleIds());
          expect(Doc.load(d.save()).text).toBe(model);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('stays correct when the B-tree grows three or more levels deep', () => {
    const rand = rng(42);
    const d = new Doc({ agent: 'a' });
    const r = new Doc({ agent: 'b' });
    let model = '';
    for (let i = 0; i < 40_000; i++) {
      if (rand() < 0.7 || model.length === 0) {
        const p = Math.floor(rand() * (model.length + 1));
        const s = String.fromCharCode(97 + (i % 26));
        d.insert(p, s);
        model = model.slice(0, p) + s + model.slice(p);
      } else {
        const p = Math.floor(rand() * model.length);
        d.delete(p, 1);
        model = model.slice(0, p) + model.slice(p + 1);
      }
      if (i % 5000 === 0) r.applyRemote(d.getOps(r.version()));
    }
    r.applyRemote(d.getOps(r.version()));
    expect(d.text).toBe(model);
    expect(r.text).toBe(model);
    expect(d.stats().btreeDepth).toBeGreaterThanOrEqual(3);
  });
});
