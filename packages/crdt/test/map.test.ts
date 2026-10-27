import { describe, expect, it } from 'vitest';
import { Doc, LWWMap } from '../src/index.js';

describe('LWW map', () => {
  it('higher Lamport timestamp wins regardless of arrival order', () => {
    const m1 = new LWWMap();
    const m2 = new LWWMap();
    m1.apply('k', 'old', 1, 'b');
    m1.apply('k', 'new', 2, 'a');
    m2.apply('k', 'new', 2, 'a');
    m2.apply('k', 'old', 1, 'b');
    expect(m1.get('k')).toBe('new');
    expect(m2.get('k')).toBe('new');
  });

  it('equal timestamps are broken by agent id', () => {
    const m = new LWWMap();
    m.apply('k', 'from-b', 5, 'b');
    m.apply('k', 'from-a', 5, 'a');
    expect(m.get('k')).toBe('from-b');
  });

  it('delete is a tombstone ordered like any other write', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    a.setMeta('title', 'x');
    b.applyRemote(a.getOps());
    b.setMeta('title', undefined); // delete, causally after the set
    a.setMeta('icon', 'star'); // concurrent, different key
    a.applyRemote(b.getOps(a.version()));
    b.applyRemote(a.getOps(b.version()));
    expect(a.meta()).toEqual({ icon: 'star' });
    expect(b.meta()).toEqual(a.meta());
  });

  it('stores JSON values of every type', () => {
    const d = new Doc({ agent: 'a' });
    const values = { n: null, t: true, f: false, i: -42, x: 3.25, s: 'hi', arr: [1, 'two'], obj: { a: { b: [] } } };
    for (const [k, v] of Object.entries(values)) d.setMeta(k, v);
    expect(Doc.load(d.save()).meta()).toEqual(values);
  });
});
