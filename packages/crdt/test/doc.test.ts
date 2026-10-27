import { describe, expect, it } from 'vitest';
import { Doc, type ChangeEvent, type InsertOp, type Op, type TextPatch } from '../src/index.js';

function applyPatch(s: string, p: TextPatch): string {
  return p.type === 'insert'
    ? s.slice(0, p.pos) + p.text + s.slice(p.pos)
    : s.slice(0, p.pos) + s.slice(p.pos + p.len);
}

describe('doc: causality, buffering, sync', () => {
  it('buffers ops whose dependencies have not arrived, then applies them', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'hello');
    a.insert(0, '>'); // not a continuation, so a separate op
    a.delete(0, 1);
    const ops = a.getOps();
    expect(ops).toHaveLength(3);
    const b = new Doc({ agent: 'b' });
    expect(b.applyRemote([ops[2]!])).toEqual({ applied: 0, duplicates: 0, pending: 1 });
    expect(b.applyRemote([ops[1]!]).pending).toBe(2);
    expect(b.applyRemote([ops[0]!])).toEqual({ applied: 3, duplicates: 0, pending: 0 });
    expect(b.text).toBe(a.text);
  });

  it("waits for a third party's op referenced as an origin", () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    const c = new Doc({ agent: 'c' });
    a.insert(0, 'base');
    b.applyRemote(a.getOps());
    b.insert(4, '!'); // depends on a's chars
    c.applyRemote(b.getOps({ a: 4 })); // only b's op
    expect(c.pending).toBe(1);
    expect(c.text).toBe('');
    c.applyRemote(a.getOps());
    expect(c.pending).toBe(0);
    expect(c.text).toBe('base!');
  });

  it('is idempotent, including for partially-seen merged ops', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'abc');
    const b = new Doc({ agent: 'b' });
    b.applyRemote(a.getOps());
    a.insert(3, 'def'); // merges into one op 'abcdef' in a's log
    expect(a.getOps()).toHaveLength(1);
    const res = b.applyRemote(a.getOps()); // overlaps what b already has
    expect(res.applied).toBe(1);
    expect(b.text).toBe('abcdef');
    expect(b.applyRemote(a.getOps())).toEqual({ applied: 0, duplicates: 1, pending: 0 });
    expect(b.text).toBe('abcdef');
  });

  it('run-length encodes backspaces and trims a partially-seen run correctly', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'abcdef');
    const b = new Doc({ agent: 'b' });
    b.applyRemote(a.getOps());
    a.delete(5, 1); // backspace 'f'
    b.applyRemote(a.getOps(b.version())); // b sees only the first backspace
    a.delete(4, 1); // 'e'
    a.delete(3, 1); // 'd'
    a.delete(0, 1); // 'a' (not adjacent: new range)
    const log = a.getOps();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({
      kind: 'del',
      seq: 6,
      targets: [
        { agent: 'a', seq: 3, len: 3, rev: true },
        { agent: 'a', seq: 0, len: 1 },
      ],
    });
    // b already has unit 0 (deleting 'f'); the trimmed op must delete d, e, a.
    b.applyRemote(a.getOps(b.version()));
    expect(b.text).toBe('bc');
    expect(a.text).toBe('bc');
  });

  it('getOps(version) returns exactly the missing suffix', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'abcdef');
    const ops = a.getOps({ a: 4 });
    expect(ops).toHaveLength(1);
    const ins = ops[0] as InsertOp;
    expect(ins.seq).toBe(4);
    expect(ins.content).toBe('ef');
    expect(ins.originLeft).toEqual({ agent: 'a', seq: 3 });
    expect(a.getOps(a.version())).toEqual([]);
  });

  it('tracks version vectors and Lamport clocks', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    a.insert(0, 'xyz');
    a.setMeta('title', 'T');
    b.applyRemote(a.getOps());
    expect(b.version()).toEqual({ a: 4 });
    b.setMeta('title', 'U'); // causally after a's write, so it must win
    a.applyRemote(b.getOps(a.version()));
    expect(a.getMeta('title')).toBe('U');
    expect(a.version()).toEqual({ a: 4, b: 1 });
  });

  it('emits change events with text patches for local and remote edits', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    const events: ChangeEvent[] = [];
    const off = b.on('change', (e) => events.push(e));
    a.insert(0, 'hello world');
    b.applyRemote(a.getOps());
    a.delete(0, 6);
    a.setMeta('title', 'x');
    a.movePage('p1');
    b.applyRemote(a.getOps(b.version()));
    b.insert(0, '>');
    off();
    b.insert(0, 'ignored');

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ origin: 'remote', text: [{ type: 'insert', pos: 0, text: 'hello world' }] });
    expect(events[1]).toMatchObject({
      origin: 'remote',
      text: [{ type: 'delete', pos: 0, len: 6 }],
      meta: ['title'],
      tree: true,
    });
    expect(events[2]).toMatchObject({ origin: 'local', text: [{ type: 'insert', pos: 0, text: '>' }] });

    // Replaying the patches onto a plain string reproduces the document.
    let s = '';
    for (const e of events) for (const p of e.text) s = applyPatch(s, p);
    expect(s).toBe('>world');
  });

  it('remote text patches replay to the same string under concurrency', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    const c = new Doc({ agent: 'c' });
    a.insert(0, 'the quick fox');
    b.applyRemote(a.getOps());
    b.insert(4, 'very ');
    b.delete(0, 4);
    a.insert(9, ' brown');
    a.delete(0, 1);
    let mirror = '';
    c.on('change', (e) => {
      for (const p of e.text) mirror = applyPatch(mirror, p);
    });
    const ops: Op[] = [...b.getOps(), ...a.getOps()]; // b's ops arrive first: buffered
    c.applyRemote(ops);
    expect(c.pending).toBe(0);
    expect(mirror).toBe(c.text);
  });

  it('snapshots load into an equivalent replica that can keep editing', () => {
    const a = new Doc({ agent: 'a' });
    a.insert(0, 'note body');
    a.setMeta('title', 'Groceries');
    a.setMeta('pinned', true);
    a.movePage('p1');
    a.movePage('p2', 'p1');
    const a2 = Doc.load(a.save(), { agent: 'a' }); // same device, same agent
    expect(a2.text).toBe('note body');
    expect(a2.meta()).toEqual({ pinned: true, title: 'Groceries' });
    expect(a2.pageParent('p2')).toBe('p1');
    a2.insert(0, '> ');
    expect(a2.version()).toEqual({ a: 15 });
    const other = new Doc({ agent: 'z' });
    other.applyRemote(a2.getOps());
    expect(other.text).toBe('> note body');
  });

  it('rejects malformed input', () => {
    const d = new Doc({ agent: 'a' });
    const bad: Op = { kind: 'ins', agent: 'x', seq: 0, lamport: 0, originLeft: null, originRight: null, content: '' };
    expect(() => d.applyRemote([bad])).toThrow(TypeError);
    expect(() => new Doc({ agent: '' })).toThrow(TypeError);
  });
});
