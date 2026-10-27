import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeWtf8, encodeWtf8 } from '../src/encoding.js';
import { decodeOps, Doc, encodeOps, isSnapshot, type Op } from '../src/index.js';

describe('binary encoding', () => {
  it('round-trips every op kind', () => {
    const a = new Doc({ agent: 'alice' });
    const b = new Doc({ agent: 'bob' });
    a.insert(0, 'héllo wörld \u{1F600}');
    b.applyRemote(a.getOps());
    b.insert(3, 'XYZ');
    b.delete(0, 2);
    b.delete(5, 3);
    b.setMeta('title', 'Notes ✓');
    b.setMeta('n', 1.5);
    b.setMeta('gone', undefined);
    b.movePage('p', 'root');
    const ops = b.getOps();
    expect(decodeOps(encodeOps(ops))).toEqual(ops);
  });

  it('WTF-8 round-trips lone surrogates that UTF-8 cannot represent', () => {
    for (const s of ['plain', '\uD800', 'x\uDC00y', '😀', '\uDE00\uD83D', 'é中']) {
      expect(decodeWtf8(encodeWtf8(s))).toBe(s);
    }
    const ops: Op[] = [
      { kind: 'ins', agent: 'a\uD800', seq: 0, lamport: 0, originLeft: null, originRight: null, content: 'x\uDC00\uD83D' },
      { kind: 'ins', agent: 'a\uD800', seq: 3, lamport: 3, originLeft: null, originRight: null, content: '\uDE00y' },
    ];
    expect(decodeOps(encodeOps(ops))).toEqual(ops);
  });

  it('round-trips op streams produced by concurrent editing (200 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            r: fc.nat(2),
            pos: fc.nat(),
            s: fc.string({ unit: 'binary', minLength: 1, maxLength: 5 }),
            del: fc.boolean(),
          }),
          { maxLength: 60, size: 'max' },
        ),
        (edits) => {
          const docs = [new Doc({ agent: 'a' }), new Doc({ agent: 'bb' }), new Doc({ agent: 'ccc' })];
          for (const e of edits) {
            const d = docs[e.r]!;
            if (e.del && d.length > 0) d.delete(e.pos % d.length, 1);
            else d.insert(e.pos % (d.length + 1), e.s);
            if (e.pos % 5 === 0) docs[(e.r + 1) % 3]!.applyRemote(d.getOps());
          }
          for (const d of docs) {
            const ops = d.getOps();
            expect(decodeOps(encodeOps(ops))).toEqual(ops);
            expect(Doc.load(d.save()).visibleIds()).toEqual(d.visibleIds());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is compact for typical typing', () => {
    const d = new Doc({ agent: 'device-1234' });
    let pos = 0;
    for (const ch of 'The quick brown fox jumps over the lazy dog.') d.insert(pos++, ch);
    d.delete(4, 6);
    const bytes = d.save();
    // 4 header + 12 agent table + 1 string table + 1 count
    // + 2 ops (~6 bytes) + 45 bytes of text
    expect(bytes.length).toBeLessThan(75);
    expect(isSnapshot(bytes)).toBe(true);
    expect(isSnapshot(encodeOps(d.getOps()))).toBe(false);
  });

  it('rejects corrupt input', () => {
    expect(() => decodeOps(new Uint8Array([1, 2, 3, 4]))).toThrow();
    const d = new Doc({ agent: 'a' });
    d.insert(0, 'abc');
    const good = encodeOps(d.getOps());
    expect(() => decodeOps(good.slice(0, good.length - 1))).toThrow();
  });
});
