/**
 * Version history on top of the op log.
 *
 * A version is a prefix of a doc's log. `getOps()` returns the log in a
 * causal order, so every prefix is causally closed and replaying it gives
 * exactly the state the document had at that point.
 *
 * Diff and restore need no diff algorithm. Fugue never reorders characters
 * (the property tests check this), and the current doc still holds every
 * character ever inserted, deleted ones as tombstones, in their one final
 * order. Walking that list and asking for each character id "was it visible
 * then? is it visible now?" gives an exact diff:
 *
 *     then  now
 *      ✓     ✓    unchanged
 *      ✓     ·    deleted since       (text taken from the past replica)
 *      ·     ✓    inserted since
 *      ·     ·    never mattered
 *
 * Restoring a version applies that diff in reverse as NEW operations
 * (delete what was inserted since, re-insert what was deleted since).
 * History is never rewritten, so a restore syncs to peers like any other
 * edit, and edits made concurrently with it merge normally.
 */
import { Doc } from './doc.js';
import type { Op } from './ops.js';

/** The document as it was after the first `count` ops of `ops`. */
export function replay(ops: readonly Op[], count = ops.length): Doc {
  const doc = new Doc({ agent: 'history-viewer' });
  doc.applyRemote(ops.slice(0, count));
  return doc;
}

export interface DiffSegment {
  type: 'same' | 'inserted' | 'deleted';
  text: string;
}

/** Changes from `past` to `current`. `past` must be a replay of a prefix of `current`'s log. */
export function diffSince(past: Doc, current: Doc): DiffSegment[] {
  const then = pastChars(past);
  const out: DiffSegment[] = [];
  const push = (type: DiffSegment['type'], ch: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ch;
    else out.push({ type, text: ch });
  };
  for (const c of current.allChars()) {
    const old = then.get(c.id);
    if (old !== undefined && c.visible) push('same', c.ch);
    else if (old !== undefined) push('deleted', old);
    else if (c.visible) push('inserted', c.ch);
  }
  return out;
}

/**
 * Make `doc`'s text equal to `past`'s text using new operations. Returns
 * how many characters were deleted and re-inserted.
 */
export function restore(doc: Doc, past: Doc): { deleted: number; inserted: number } {
  const then = pastChars(past);
  const chars = doc.allChars(); // snapshot before we start editing
  let pos = 0;
  let pendingDelete = 0;
  let pendingInsert = '';
  let deleted = 0;
  let inserted = 0;
  const flush = () => {
    if (pendingDelete > 0) {
      doc.delete(pos, pendingDelete);
      deleted += pendingDelete;
      pendingDelete = 0;
    }
    if (pendingInsert) {
      doc.insert(pos, pendingInsert);
      pos += pendingInsert.length;
      inserted += pendingInsert.length;
      pendingInsert = '';
    }
  };
  for (const c of chars) {
    const old = then.get(c.id);
    if (old !== undefined && c.visible) {
      flush();
      pos++;
    } else if (c.visible) {
      if (pendingInsert) flush();
      pendingDelete++; // inserted since: remove it
    } else if (old !== undefined) {
      if (pendingDelete) flush();
      pendingInsert += old; // deleted since: bring it back as new text
    }
  }
  flush();
  return { deleted, inserted };
}

function pastChars(past: Doc): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of past.allChars()) if (c.visible) m.set(c.id, c.ch);
  return m;
}
