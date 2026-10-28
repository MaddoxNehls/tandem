/**
 * Binding between ProseMirror and the Tandem CRDT.
 *
 *   local:  PM transaction  ──diff──▶  doc.delete / doc.insert
 *   remote: doc 'change' TextPatch[]  ──▶  PM transaction (not added to undo history)
 *
 * Positions. The CRDT text is the editor's lines joined with "\n". For a
 * character offset `o` on line `k` (k newlines before it), the ProseMirror
 * position is `o + k + 1`: each line node adds an opening token, and each
 * "\n" becomes a close+open pair (two positions instead of one character).
 *
 * Local changes are translated by diffing the text before and after the
 * transaction, using the transaction's first changed position as a hint
 * so that ambiguous edits ("aa" -> "aaa") are attributed where the user
 * typed. One transaction becomes at most one delete plus one insert.
 *
 * Remote changes are applied patch by patch. The local selection is mapped
 * through the same patches in CRDT offsets, sticking to the left of a
 * remote insertion at the cursor, so a collaborator typing exactly where you
 * are does not push your caret along.
 */
import type { Doc, TextPatch } from '@tandem/crdt';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { schema } from './schema.js';

/** Transaction meta key marking transactions that came from the CRDT. */
export const REMOTE = 'tandem-remote';

export function textOf(doc: PMNode): string {
  const lines: string[] = [];
  doc.forEach((line) => lines.push(line.textContent));
  return lines.join('\n');
}

export function docFromText(text: string): PMNode {
  return schema.node(
    'doc',
    null,
    text.split('\n').map((l) => lineNode(l)),
  );
}

function lineNode(text: string): PMNode {
  return schema.node('line', null, text ? schema.text(text) : undefined);
}

/** CRDT offset -> ProseMirror position (inside the line holding it). */
export function offsetToPos(doc: PMNode, offset: number): number {
  let start = 0; // text offset of the current line
  let pos = 0; // PM position before the current line node
  for (let i = 0; i < doc.childCount; i++) {
    const line = doc.child(i);
    const len = line.content.size;
    if (offset <= start + len) return pos + 1 + Math.max(0, offset - start);
    start += len + 1;
    pos += line.nodeSize;
  }
  // Past the end: clamp to the end of the last line.
  return doc.content.size - 1;
}

/** ProseMirror position -> CRDT offset (positions between lines map to the next line's start). */
export function posToOffset(doc: PMNode, pos: number): number {
  let start = 0;
  let nodePos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const line = doc.child(i);
    const len = line.content.size;
    if (pos <= nodePos) return start;
    if (pos <= nodePos + 1 + len) return start + (pos - nodePos - 1);
    start += len + 1;
    nodePos += line.nodeSize;
  }
  return Math.max(0, start - 1);
}

export interface TextChange {
  pos: number;
  del: number;
  ins: string;
}

/**
 * Minimal single-region change turning `a` into `b`. The common prefix is
 * capped at `hint` so the change is placed where the user edited.
 */
export function diffText(a: string, b: string, hint = Number.POSITIVE_INFINITY): TextChange {
  const max = Math.min(a.length, b.length, Math.max(0, hint));
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(a.length, b.length) - prefix;
  while (suffix < maxSuffix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  return { pos: prefix, del: a.length - prefix - suffix, ins: b.slice(prefix, b.length - suffix) };
}

/** Earliest position (in the pre-transaction doc) the transaction touched. */
function firstChange(tr: Transaction): number {
  let min = Number.POSITIVE_INFINITY;
  tr.mapping.maps.forEach((map, i) => {
    // Map each step's start back into the original document's coordinates.
    map.forEach((oldStart) => {
      const back = tr.mapping.slice(0, i).invert().map(oldStart, -1);
      min = Math.min(min, back);
    });
  });
  return min;
}

/** Apply a local ProseMirror transaction to the CRDT. Returns the change. */
export function applyLocalTransaction(doc: Doc, tr: Transaction): TextChange | null {
  if (!tr.docChanged) return null;
  const before = textOf(tr.before);
  const after = textOf(tr.doc);
  const start = firstChange(tr);
  const hint = Number.isFinite(start) ? posToOffset(tr.before, start) : Number.POSITIVE_INFINITY;
  const change = diffText(before, after, hint);
  if (change.del > 0) doc.delete(change.pos, change.del);
  if (change.ins.length > 0) doc.insert(change.pos, change.ins);
  return change;
}

/** Map a text offset through remote patches; stays left of an insert at the same offset. */
export function mapOffset(offset: number, patches: readonly TextPatch[]): number {
  let o = offset;
  for (const p of patches) {
    if (p.type === 'insert') {
      if (o > p.pos) o += p.text.length;
    } else if (o > p.pos) {
      o -= Math.min(p.len, o - p.pos);
    }
  }
  return o;
}

/** Build the ProseMirror transaction for remote CRDT patches. */
export function remoteTransaction(state: EditorState, patches: readonly TextPatch[]): Transaction {
  const tr = state.tr;
  const anchor = posToOffset(state.doc, state.selection.anchor);
  const head = posToOffset(state.doc, state.selection.head);

  for (const p of patches) {
    if (p.type === 'insert') {
      const pos = offsetToPos(tr.doc, p.pos);
      const lines = p.text.split('\n');
      if (lines.length === 1) {
        tr.insertText(p.text, pos);
      } else {
        // An open slice (depth 1 on both sides) splits the current line,
        // exactly like pasting multi-line text.
        tr.replace(pos, pos, new Slice(Fragment.from(lines.map(lineNode)), 1, 1));
      }
    } else {
      tr.delete(offsetToPos(tr.doc, p.pos), offsetToPos(tr.doc, p.pos + p.len));
    }
  }

  const a = offsetToPos(tr.doc, mapOffset(anchor, patches));
  const h = offsetToPos(tr.doc, mapOffset(head, patches));
  tr.setSelection(TextSelection.create(tr.doc, a, h));
  tr.setMeta(REMOTE, true);
  tr.setMeta('addToHistory', false);
  return tr;
}
