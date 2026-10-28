import fc from 'fast-check';
import { Doc, type TextPatch } from '@tandem/crdt';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  applyLocalTransaction,
  diffText,
  docFromText,
  mapOffset,
  offsetToPos,
  posToOffset,
  remoteTransaction,
  textOf,
} from '../src/editor/binding.js';
import { schema } from '../src/editor/schema.js';

const lineText = fc.string({ unit: fc.constantFrom('a', 'b', ' ', '#', '-', 'é', '\u{1F642}'), maxLength: 6 });
const docText = fc.array(lineText, { minLength: 1, maxLength: 6 }).map((ls) => ls.join('\n'));

function stateFor(text: string): EditorState {
  return EditorState.create({ schema, doc: docFromText(text) });
}

describe('position mapping', () => {
  it('offset <-> position round-trips for every offset (200 runs)', () => {
    fc.assert(
      fc.property(docText, (text) => {
        const doc = docFromText(text);
        expect(textOf(doc)).toBe(text);
        for (let o = 0; o <= text.length; o++) {
          const pos = offsetToPos(doc, o);
          expect(posToOffset(doc, pos)).toBe(o);
          // The position is inside a line, at the right column.
          const $pos = doc.resolve(pos);
          expect($pos.parent.type.name).toBe('line');
          expect(textOf(doc).slice(0, o).split('\n').pop()!.length).toBe($pos.parentOffset);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('diff attributes ambiguous edits to the hinted position', () => {
    expect(diffText('aa', 'aaa', 1)).toEqual({ pos: 1, del: 0, ins: 'a' });
    expect(diffText('aa', 'aaa')).toEqual({ pos: 2, del: 0, ins: 'a' });
    expect(diffText('hello', 'help')).toEqual({ pos: 3, del: 2, ins: 'p' });
    expect(diffText('abc', 'abc')).toEqual({ pos: 3, del: 0, ins: '' });
  });
});

type PMEdit =
  | { t: 'type'; at: number; s: string }
  | { t: 'enter'; at: number }
  | { t: 'delete'; at: number; len: number }
  | { t: 'paste'; at: number; lines: string[] };

const pmEdit: fc.Arbitrary<PMEdit> = fc.oneof(
  fc.record({ t: fc.constant('type' as const), at: fc.nat(), s: fc.string({ minLength: 1, maxLength: 3 }) }),
  fc.record({ t: fc.constant('enter' as const), at: fc.nat() }),
  fc.record({ t: fc.constant('delete' as const), at: fc.nat(), len: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ t: fc.constant('paste' as const), at: fc.nat(), lines: fc.array(lineText, { minLength: 2, maxLength: 3 }) }),
);

/** Apply an edit the way the editor would (by PM positions). */
function applyPM(state: EditorState, e: PMEdit): EditorState {
  const text = textOf(state.doc);
  const at = offsetToPos(state.doc, e.at % (text.length + 1));
  const tr = state.tr;
  switch (e.t) {
    case 'type':
      tr.insertText(e.s, at);
      break;
    case 'enter':
      tr.split(at);
      break;
    case 'delete': {
      const end = offsetToPos(state.doc, Math.min(text.length, (e.at % (text.length + 1)) + e.len));
      if (end > at) tr.delete(at, end);
      break;
    }
    case 'paste':
      tr.replace(at, at, new Slice(Fragment.from(e.lines.map((l) => schema.node('line', null, l ? schema.text(l) : undefined))), 1, 1));
      break;
  }
  return state.apply(tr);
}

describe('local ProseMirror transactions -> CRDT', () => {
  it('the CRDT text always equals the editor text (300 runs)', () => {
    fc.assert(
      fc.property(fc.array(pmEdit, { minLength: 1, maxLength: 40 }), (edits) => {
        const doc = new Doc({ agent: 'me' });
        let state = stateFor('');
        for (const e of edits) {
          const text = textOf(state.doc);
          const at = offsetToPos(state.doc, e.at % (text.length + 1));
          const tr = state.tr;
          if (e.t === 'type') tr.insertText(e.s, at);
          else if (e.t === 'enter') tr.split(at);
          else if (e.t === 'delete') {
            const end = offsetToPos(state.doc, Math.min(text.length, (e.at % (text.length + 1)) + e.len));
            if (end > at) tr.delete(at, end);
          } else tr.replace(at, at, new Slice(Fragment.from(e.lines.map((l) => schema.node('line', null, l ? schema.text(l) : undefined))), 1, 1));
          applyLocalTransaction(doc, tr);
          state = state.apply(tr);
          expect(doc.text).toBe(textOf(state.doc));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a multi-step transaction becomes one region change', () => {
    const doc = new Doc({ agent: 'me' });
    doc.insert(0, 'one\ntwo\nthree');
    const state = stateFor(doc.text);
    const tr = state.tr.insertText('X', offsetToPos(state.doc, 4)).insertText('Y', offsetToPos(state.doc, 9) + 1);
    const change = applyLocalTransaction(doc, tr)!;
    expect(doc.text).toBe(textOf(tr.doc));
    expect(change.pos).toBe(4);
  });
});

describe('remote CRDT patches -> ProseMirror', () => {
  it('the editor text always equals the CRDT text after remote patches (300 runs)', () => {
    fc.assert(
      fc.property(
        docText,
        fc.array(fc.record({ ins: fc.boolean(), at: fc.nat(), s: fc.string({ unit: fc.constantFrom('x', '\n', 'y', ' '), minLength: 1, maxLength: 5 }), len: fc.integer({ min: 1, max: 5 }) }), { minLength: 1, maxLength: 20 }),
        (initial, edits) => {
          const remote = new Doc({ agent: 'remote' });
          if (initial) remote.insert(0, initial);
          const local = new Doc({ agent: 'local' });
          local.applyRemote(remote.getOps());
          let state = stateFor(local.text);
          local.on('change', (e) => {
            if (e.origin === 'remote') state = state.apply(remoteTransaction(state, e.text));
          });
          for (const e of edits) {
            if (e.ins || remote.length === 0) remote.insert(e.at % (remote.length + 1), e.s);
            else {
              const p = e.at % remote.length;
              remote.delete(p, Math.min(e.len, remote.length - p));
            }
            local.applyRemote(remote.getOps(local.version()));
            expect(textOf(state.doc)).toBe(local.text);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('round trip: PM A -> CRDT A -> CRDT B -> PM B', () => {
    const a = new Doc({ agent: 'a' });
    const b = new Doc({ agent: 'b' });
    let sa = stateFor('');
    let sb = stateFor('');
    b.on('change', (e) => {
      if (e.origin === 'remote') sb = sb.apply(remoteTransaction(sb, e.text));
    });
    for (const e of [
      { t: 'type', at: 0, s: '# Title' },
      { t: 'enter', at: 7 },
      { t: 'type', at: 8, s: '- milk' },
      { t: 'paste', at: 14, lines: ['', '- eggs', '- bread'] },
      { t: 'delete', at: 2, len: 6 },
    ] as PMEdit[]) {
      const next = applyPM(sa, e);
      const tr = sa.tr.replaceWith(0, sa.doc.content.size, next.doc.content);
      applyLocalTransaction(a, tr);
      sa = next;
      b.applyRemote(a.getOps(b.version()));
    }
    expect(textOf(sb.doc)).toBe(textOf(sa.doc));
    expect(b.text).toBe(a.text);
  });
});

describe('selection is preserved across remote edits', () => {
  function setup(text: string, cursor: number) {
    const remote = new Doc({ agent: 'remote' });
    remote.insert(0, text);
    const local = new Doc({ agent: 'local' });
    local.applyRemote(remote.getOps());
    let state = stateFor(text);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, offsetToPos(state.doc, cursor))));
    const box = { state };
    local.on('change', (e) => {
      if (e.origin === 'remote') box.state = box.state.apply(remoteTransaction(box.state, e.text));
    });
    const sync = () => local.applyRemote(remote.getOps(local.version()));
    const cursorOffset = () => posToOffset(box.state.doc, box.state.selection.head);
    return { remote, sync, box, cursorOffset };
  }

  it('shifts right when text is inserted before the cursor', () => {
    const s = setup('hello world', 6);
    s.remote.insert(0, 'oh, ');
    s.sync();
    expect(s.cursorOffset()).toBe(10);
    expect(textOf(s.box.state.doc).slice(s.cursorOffset())).toBe('world');
  });

  it('stays put when text is inserted after the cursor, or exactly at it', () => {
    const s = setup('hello world', 5);
    s.remote.insert(11, '!');
    s.remote.insert(5, ' there');
    s.sync();
    expect(s.cursorOffset()).toBe(5);
  });

  it('follows line splits and joins above it', () => {
    const s = setup('one two\nthree', 10);
    s.remote.insert(3, '\n');
    s.sync();
    expect(s.cursorOffset()).toBe(11);
    expect(s.box.state.selection.$head.parent.textContent).toBe('three');
    s.remote.delete(3, 1); // join "one" and " two" again
    s.sync();
    expect(s.cursorOffset()).toBe(10);
  });

  it('collapses to the deletion point when its text is deleted', () => {
    const s = setup('abcdef', 4);
    s.remote.delete(2, 3);
    s.sync();
    expect(s.cursorOffset()).toBe(2);
  });

  it('keeps a range selection around the same text', () => {
    const remote = new Doc({ agent: 'remote' });
    remote.insert(0, 'select me please');
    const local = new Doc({ agent: 'local' });
    local.applyRemote(remote.getOps());
    let state = stateFor(local.text);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, offsetToPos(state.doc, 7), offsetToPos(state.doc, 9))));
    local.on('change', (e) => {
      if (e.origin === 'remote') state = state.apply(remoteTransaction(state, e.text));
    });
    remote.insert(0, '>> ');
    local.applyRemote(remote.getOps(local.version()));
    const { from, to } = state.selection;
    expect(state.doc.textBetween(from, to)).toBe('me');
  });

  it('mapOffset follows patch semantics', () => {
    const patches: TextPatch[] = [
      { type: 'insert', pos: 2, text: 'xx' },
      { type: 'delete', pos: 0, len: 1 },
    ];
    expect(mapOffset(1, patches)).toBe(0);
    expect(mapOffset(2, patches)).toBe(1);
    expect(mapOffset(3, patches)).toBe(4);
  });
});
