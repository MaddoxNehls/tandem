import { describe, expect, it } from 'vitest';
import { Doc, InvalidOpError, validateOp, type ChangeEvent, type InsertOp, type Op, type TextPatch } from '../src/index.js';

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

  it('rejects a malformed batch before applying anything', () => {
    const d = new Doc({ agent: 'a' });
    const bad: Op = { kind: 'ins', agent: 'x', seq: 0, lamport: 0, originLeft: null, originRight: null, content: '' };
    expect(() => d.applyRemote([bad])).toThrow(InvalidOpError);
    expect(() => new Doc({ agent: '' })).toThrow(TypeError);

    const good = new Doc({ agent: 'g' });
    good.insert(0, 'ok');
    const batch: Op[] = [...good.getOps(), { ...bad, content: 'x', seq: -1 }];
    expect(() => d.applyRemote(batch)).toThrow(InvalidOpError);
    expect(d.text).toBe(''); // the valid op in the batch was not applied either
  });

  it('rejects ops that reference non-character ids, without partial effects', () => {
    const a = new Doc({ agent: 'a' });
    a.setMeta('k', 1); // a:0 is a map op, not a character
    const d = new Doc({ agent: 'd' });
    d.applyRemote(a.getOps());
    const forgedDel: Op = { kind: 'del', agent: 'm', seq: 0, lamport: 5, targets: [{ agent: 'a', seq: 0, len: 1 }] };
    expect(() => d.applyRemote([forgedDel])).toThrow(InvalidOpError);
    expect(d.version()).toEqual({ a: 1 });
    const forgedIns: Op = {
      kind: 'ins',
      agent: 'm',
      seq: 0,
      lamport: 5,
      originLeft: { agent: 'a', seq: 0 },
      originRight: null,
      content: 'x',
    };
    expect(() => d.applyRemote([forgedIns])).toThrow(InvalidOpError);
    expect(d.text).toBe('');
    expect(d.version()).toEqual({ a: 1 });
  });

  it('validateOp enforces shapes and bounds', () => {
    const ok: Op = {
      kind: 'ins',
      agent: 'a',
      seq: 3,
      lamport: 3,
      originLeft: { agent: 'a', seq: 2 },
      originRight: null,
      content: 'x',
    };
    expect(validateOp(ok)).toBeNull();
    expect(validateOp({ ...ok, originLeft: { agent: 'a', seq: 3 } })).toMatch(/itself/);
    expect(validateOp({ ...ok, seq: 1.5 })).toBe('bad seq');
    expect(validateOp({ ...ok, lamport: 2 ** 60 })).toBe('bad lamport');
    expect(validateOp({ ...ok, agent: 'x'.repeat(65) })).toBe('bad agent');
    expect(validateOp({ ...ok, kind: 'nope' })).toBe('unknown op kind');
    expect(validateOp({ kind: 'del', agent: 'a', seq: 1, lamport: 1, targets: [{ agent: 'a', seq: 0, len: 0 }] })).toBe(
      'bad delete target',
    );
    expect(validateOp({ kind: 'del', agent: 'a', seq: 1, lamport: 1, targets: [{ agent: 'a', seq: 0, len: 2 }] })).toMatch(
      /itself/,
    );
    expect(validateOp({ kind: 'move', agent: 'a', seq: 0, lamport: 0, node: '', parent: 'root' })).toBe('bad tree node id');
    expect(validateOp({ kind: 'set', agent: 'a', seq: 0, lamport: 0, key: 'k', value: 'x'.repeat(70_000) })).toBe('bad value');
    expect(validateOp(null)).toBe('op must be an object');
  });

  it('cursor refs track a character through concurrent edits', () => {
    const c = new Doc({ agent: 'c' });
    c.insert(0, 'abc');
    expect(c.cursorAt(0)).toBeNull();
    const afterB = c.cursorAt(2); // between "b" and "c"
    expect(afterB).toEqual({ agent: 'c', seq: 1 });

    const other = new Doc({ agent: 'o' });
    other.applyRemote(c.getOps());
    other.insert(0, 'XY');
    c.applyRemote(other.getOps(c.version()));
    expect(c.text).toBe('XYabc');
    expect(c.resolveCursor(afterB)).toBe(4);

    c.delete(3, 1); // delete "b": the cursor stays where "b" was
    expect(c.text).toBe('XYac');
    expect(c.resolveCursor(afterB)).toBe(3);
    expect(c.resolveCursor(null)).toBe(0);
    expect(c.resolveCursor({ agent: 'unknown', seq: 0 })).toBeNull();
    expect(() => c.cursorAt(99)).toThrow(RangeError);
  });
});
