/**
 * Fugue text sequence CRDT (FugueMax semantics), with run-length-encoded
 * items stored in a B-tree.
 *
 * ## Model
 * Every character ever inserted is an *item* with a globally unique id
 * `(agent, seq)`. Items are never removed: deleting a character turns it
 * into a tombstone. Each item records two *origins* captured at insert time:
 *
 *   - originLeft:  the visible character immediately to the left of the
 *                  cursor (or NONE for "start of document");
 *   - originRight: the item (possibly a tombstone) that came immediately
 *                  after originLeft in the inserting replica's list (or NONE
 *                  for "end of document").
 *
 * A remote insert is placed between its origins; when other items already
 * sit between them (i.e. they were inserted concurrently), `integrate`
 * decides the order deterministically. The rule implemented here is
 * Gentle's list-based "YjsMod" integration. Weidner & Kleppmann ("The Art
 * of the Fugue", arXiv:2305.00583, sections 3.1 and 8) *conjecture* that
 * YjsMod is semantically equivalent to their tree-based FugueMax, which they
 * prove maximally non-interleaving: two users typing concurrently at the same
 * spot end up with their runs side by side, never shuffled
 * character-by-character, whether they type forwards or backwards. We check
 * that conjecture for this implementation with a differential test against a
 * paper-faithful FugueMax (test/fuguemax.differential.test.ts).
 *
 * ## Representation
 * Consecutive characters typed by one agent with consecutive seqs (where
 * each char's originLeft is the previous char and all share an originRight)
 * are stored as one `Span`. Only the first char's originLeft is stored; the
 * originLeft of char k > 0 is implicitly (agent, seq + k - 1). A span is
 * split when an edit lands inside it, and adjacent tombstone fragments of
 * the same run are merged back together.
 *
 * Spans live in the leaves of a B-tree (fan-out `MAX_FANOUT`) whose internal
 * nodes cache two counts per subtree:
 *   - raw: number of items including tombstones (used by `integrate`);
 *   - vis: number of visible characters (used by local positions).
 *
 * A second index, `runs[agent]`, maps ids to spans: one entry per insert run
 * (append-only, sorted by seq because an agent's seqs only grow), each
 * holding its current fragments sorted by seq. Both lookups are binary
 * searches, so id -> span is O(log n).
 *
 * ## Complexity (n = number of spans, B = MAX_FANOUT)
 *   - locate by visible / raw index:        O(B log_B n)
 *   - id -> span:                           O(log n)
 *   - span -> raw / visible index:          O(B log_B n) (walk to root)
 *   - local insert / delete:                O(B log_B n) plus O(k) per
 *                                           span split for the run index
 *   - remote insert:                        O(B log_B n) when there is no
 *                                           concurrency at that spot; with c
 *                                           concurrent items between the
 *                                           origins, O(c * B log_B n)
 *   - toString:                             O(n)
 */

import { appendFlattening } from './strings.js';

/** Sentinel agent index meaning "no origin" (document start / end). */
export const NONE = -1;

export interface Span {
  agent: number;
  seq: number;
  len: number;
  /** Characters of the span; emptied once the span is deleted. */
  content: string;
  deleted: boolean;
  /** Appends since `content` was last flattened (see strings.ts). */
  appends: number;
  /** originLeft of the first character (agent NONE = document start). */
  olAgent: number;
  olSeq: number;
  /** originRight shared by every character (agent NONE = document end). */
  orAgent: number;
  orSeq: number;
  leaf: Leaf;
  run: Run;
}

interface Run {
  seq: number;
  len: number;
  /** Current fragments of this run, sorted by seq, contiguous. */
  frags: Span[];
}

export interface DeleteTarget {
  agent: number;
  seq: number;
  len: number;
}

export interface Origins {
  olAgent: number;
  olSeq: number;
  orAgent: number;
  orSeq: number;
}

export type TextPatch =
  | { type: 'insert'; pos: number; text: string }
  | { type: 'delete'; pos: number; len: number };

/** Maximum spans per leaf / children per internal node. */
const MAX_FANOUT = 64;

class Leaf {
  readonly isLeaf = true as const;
  parent: Internal | null = null;
  items: Span[] = [];
  raw = 0;
  vis = 0;
  next: Leaf | null = null;
}

class Internal {
  readonly isLeaf = false as const;
  parent: Internal | null = null;
  children: TreeNode[] = [];
  raw = 0;
  vis = 0;
}

type TreeNode = Leaf | Internal;

interface Location {
  leaf: Leaf;
  idx: number;
  offset: number;
}

const visLen = (s: Span): number => (s.deleted ? 0 : s.len);

export class FugueText {
  private root: TreeNode;
  private readonly firstLeaf: Leaf;
  /** runs[agentIndex] = insert runs of that agent, sorted by seq. */
  private readonly runs: Run[][] = [];

  /**
   * @param agentName maps an interned agent index to its globally unique
   *   name. Names (not indices) are compared for the concurrent tiebreak, so
   *   every replica orders conflicts the same way.
   */
  constructor(private readonly agentName: (agent: number) => string) {
    this.firstLeaf = new Leaf();
    this.root = this.firstLeaf;
  }

  /** Number of visible characters. */
  get length(): number {
    return this.root.vis;
  }

  /** Number of items including tombstones. */
  get rawLength(): number {
    return this.root.raw;
  }

  toString(): string {
    const parts: string[] = [];
    for (let leaf: Leaf | null = this.firstLeaf; leaf; leaf = leaf.next) {
      for (const s of leaf.items) if (!s.deleted) parts.push(s.content);
    }
    return parts.join('');
  }

  /** Visible character ids in document order, as "agent:seq" (testing aid). */
  visibleIds(): string[] {
    const out: string[] = [];
    for (let leaf: Leaf | null = this.firstLeaf; leaf; leaf = leaf.next) {
      for (const s of leaf.items) {
        if (s.deleted) continue;
        const name = this.agentName(s.agent);
        for (let k = 0; k < s.len; k++) out.push(`${name}:${s.seq + k}`);
      }
    }
    return out;
  }

  /**
   * Every character ever inserted, in list order, including tombstones
   * (whose content is no longer stored: `ch` is '' for them).
   */
  allChars(): { id: string; ch: string; visible: boolean }[] {
    const out: { id: string; ch: string; visible: boolean }[] = [];
    for (let leaf: Leaf | null = this.firstLeaf; leaf; leaf = leaf.next) {
      for (const s of leaf.items) {
        const name = this.agentName(s.agent);
        for (let k = 0; k < s.len; k++) {
          out.push({ id: `${name}:${s.seq + k}`, ch: s.deleted ? '' : s.content[k]!, visible: !s.deleted });
        }
      }
    }
    return out;
  }

  /** Internal statistics, used by benchmarks and tests. */
  stats(): { spans: number; leaves: number; depth: number } {
    let spans = 0;
    let leaves = 0;
    for (let leaf: Leaf | null = this.firstLeaf; leaf; leaf = leaf.next) {
      leaves++;
      spans += leaf.items.length;
    }
    let depth = 1;
    for (let n: TreeNode = this.root; !n.isLeaf; n = n.children[0]!) depth++;
    return { spans, leaves, depth };
  }

  // ---------------------------------------------------------------------------
  // Local operations. These take visible positions and return the metadata
  // needed to build the replicated op.
  // ---------------------------------------------------------------------------

  /**
   * Insert `content` (non-empty) at visible position `pos`, as chars
   * (agent, seq), (agent, seq+1), ... Returns the origins of the first char.
   */
  localInsert(agent: number, seq: number, pos: number, content: string): Origins {
    if (pos < 0 || pos > this.length || !Number.isInteger(pos)) {
      throw new RangeError(`insert position ${pos} out of range [0, ${this.length}]`);
    }
    const span = this.makeSpan(agent, seq, content, NONE, 0, NONE, 0);

    if (pos === 0) {
      // originLeft = start; originRight = first item in the list, if any.
      const first = this.firstSpan();
      if (first) {
        span.orAgent = first.agent;
        span.orSeq = first.seq;
      }
      this.insertIntoLeaf(this.firstLeaf, 0, span);
      this.addRun(span);
      return origins(span);
    }

    const loc = this.locateVisible(pos - 1);
    const left = loc.leaf.items[loc.idx]!;
    span.olAgent = left.agent;
    span.olSeq = left.seq + loc.offset;

    if (loc.offset < left.len - 1) {
      // Cursor is inside `left`: originRight is the next char of that span.
      span.orAgent = left.agent;
      span.orSeq = left.seq + loc.offset + 1;
      this.splitSpan(left, loc.offset + 1);
      this.insertAfter(left, span);
      this.addRun(span);
      return origins(span);
    }

    const next = this.nextSpan(left);
    if (next) {
      span.orAgent = next.agent;
      span.orSeq = next.seq;
    }

    // Fast path for ordinary typing: extend the span we are appending to.
    if (
      left.agent === agent &&
      left.seq + left.len === seq &&
      left.orAgent === span.orAgent &&
      left.orSeq === span.orSeq &&
      left.run.seq + left.run.len === seq
    ) {
      const result = origins(span);
      [left.content, left.appends] = appendFlattening(left.content, content, left.appends);
      left.len += content.length;
      left.run.len += content.length;
      this.adjust(left.leaf, content.length, content.length);
      return result;
    }

    this.insertAfter(left, span);
    this.addRun(span);
    return origins(span);
  }

  /** Delete `len` visible chars starting at `pos`; returns the deleted ids. */
  localDelete(pos: number, len: number): DeleteTarget[] {
    if (
      !Number.isInteger(pos) ||
      !Number.isInteger(len) ||
      pos < 0 ||
      len < 0 ||
      pos + len > this.length
    ) {
      throw new RangeError(`delete range [${pos}, ${pos + len}) out of range [0, ${this.length}]`);
    }
    const targets: DeleteTarget[] = [];
    while (len > 0) {
      const loc = this.locateVisible(pos);
      let s = loc.leaf.items[loc.idx]!;
      if (loc.offset > 0) s = this.splitSpan(s, loc.offset);
      const n = Math.min(len, s.len);
      if (n < s.len) this.splitSpan(s, n);
      pushTarget(targets, s.agent, s.seq, n);
      this.markDeleted(s);
      len -= n; // the following chars shift left into `pos`
    }
    return targets;
  }

  // ---------------------------------------------------------------------------
  // Remote operations. Callers guarantee causal readiness: every id an op
  // references already exists here, and the op itself is not a duplicate.
  // ---------------------------------------------------------------------------

  /**
   * Integrate a remote run of characters. Returns its visible position when
   * `wantPos` is set (for change events), otherwise -1.
   */
  remoteInsert(
    agent: number,
    seq: number,
    content: string,
    o: Origins,
    wantPos: boolean,
  ): number {
    const span = this.makeSpan(agent, seq, content, o.olAgent, o.olSeq, o.orAgent, o.orSeq);
    const total = this.root.raw;
    const left = o.olAgent === NONE ? -1 : this.rawIndexOfId(o.olAgent, o.olSeq);
    const right = o.orAgent === NONE ? total : this.rawIndexOfId(o.orAgent, o.orSeq);
    const name = this.agentName(agent);

    // Scan the items between the origins (all of them concurrent with the
    // new insert) to find its position. Raw indices are in characters; we
    // step a whole span at a time because only a span's first char can have
    // an originLeft at or before `left` (the rest point at their predecessor).
    let i = left + 1;
    let dest = i;
    let scanning = false;
    let cur: Span | null = null;
    let off = 0;
    if (i < total) {
      const loc = this.locateRaw(i);
      cur = loc.leaf.items[loc.idx]!;
      off = loc.offset;
    }

    for (;;) {
      if (!scanning) dest = i;
      if (i === total || i === right) break;
      const other = cur!;
      const oleft =
        off > 0 ? i - 1 : other.olAgent === NONE ? -1 : this.rawIndexOfId(other.olAgent, other.olSeq);
      const oright =
        other.orAgent === NONE ? total : this.rawIndexOfId(other.orAgent, other.orSeq);

      if (oleft < left) break;
      if (oleft === left) {
        if (oright < right) {
          // `other` may belong to a sibling that sorts after us; keep
          // scanning but remember where we would have gone.
          scanning = true;
        } else if (oright === right) {
          // True sibling conflict: order by agent name.
          if (name < this.agentName(other.agent)) break;
          scanning = false;
        } else {
          scanning = false;
        }
      }
      // oleft > left: `other` is nested inside an earlier item; skip it.

      const end = i + other.len - off;
      if (right > i && right < end) {
        i = right; // break at the top of the loop
        continue;
      }
      i = end;
      cur = this.nextSpan(other);
      off = 0;
    }

    this.insertAtRaw(dest, span);
    this.addRun(span);
    return wantPos ? this.visIndexOf(span) : -1;
  }

  /** Delete the given id ranges. Already-deleted chars are skipped. */
  remoteDelete(targets: readonly DeleteTarget[], patches: TextPatch[] | null): void {
    for (const t of targets) {
      let seq = t.seq;
      let rem = t.len;
      while (rem > 0) {
        let s = this.findSpan(t.agent, seq);
        const o = seq - s.seq;
        const n = Math.min(rem, s.len - o);
        if (!s.deleted) {
          if (o > 0) s = this.splitSpan(s, o);
          if (n < s.len) this.splitSpan(s, n);
          if (patches) patches.push({ type: 'delete', pos: this.visIndexOf(s), len: n });
          this.markDeleted(s);
        }
        seq += n;
        rem -= n;
      }
    }
  }

  /** Whether every char (agent, seq) .. (agent, seq + len - 1) exists here. */
  hasRange(agent: number, seq: number, len: number): boolean {
    const runs = this.runs[agent];
    if (!runs) return false;
    while (len > 0) {
      const r = runs[upperBound(runs, seq) - 1];
      if (!r || seq >= r.seq + r.len) return false;
      const n = Math.min(len, r.seq + r.len - seq);
      seq += n;
      len -= n;
    }
    return true;
  }

  /** Id of the visible char at `pos` (0 <= pos < length). */
  idAtVisible(pos: number): { agent: number; seq: number } {
    const loc = this.locateVisible(pos);
    const s = loc.leaf.items[loc.idx]!;
    return { agent: s.agent, seq: s.seq + loc.offset };
  }

  /**
   * Visible position just after char (agent, seq); if that char has been
   * deleted, the position where it used to be.
   */
  visibleOffsetAfter(agent: number, seq: number): number {
    const s = this.findSpan(agent, seq);
    const base = this.visIndexOf(s);
    return s.deleted ? base : base + (seq - s.seq) + 1;
  }

  // ---------------------------------------------------------------------------
  // B-tree internals
  // ---------------------------------------------------------------------------

  private makeSpan(
    agent: number,
    seq: number,
    content: string,
    olAgent: number,
    olSeq: number,
    orAgent: number,
    orSeq: number,
  ): Span {
    return {
      agent,
      seq,
      len: content.length,
      content,
      deleted: false,
      appends: 0,
      olAgent,
      olSeq,
      orAgent,
      orSeq,
      leaf: this.firstLeaf, // set properly on insertion
      run: DUMMY_RUN, // set by addRun
    };
  }

  private addRun(span: Span): void {
    let runs = this.runs[span.agent];
    if (!runs) {
      runs = [];
      this.runs[span.agent] = runs;
    }
    const run: Run = { seq: span.seq, len: span.len, frags: [span] };
    span.run = run;
    // Runs arrive in seq order per agent (local seqs only grow; remote ops
    // are applied in per-agent seq order), so this is an append.
    runs.push(run);
  }

  private findSpan(agent: number, seq: number): Span {
    const runs = this.runs[agent];
    const run = runs?.[upperBound(runs, seq) - 1];
    if (!run || seq >= run.seq + run.len) {
      throw new Error(`unknown character id ${this.agentName(agent)}:${seq}`);
    }
    return run.frags[upperBound(run.frags, seq) - 1]!;
  }

  private rawIndexOfId(agent: number, seq: number): number {
    const s = this.findSpan(agent, seq);
    return this.rawIndexOf(s) + (seq - s.seq);
  }

  private firstSpan(): Span | null {
    for (let leaf: Leaf | null = this.firstLeaf; leaf; leaf = leaf.next) {
      if (leaf.items.length > 0) return leaf.items[0]!;
    }
    return null;
  }

  private nextSpan(s: Span): Span | null {
    const items = s.leaf.items;
    const i = items.indexOf(s);
    if (i + 1 < items.length) return items[i + 1]!;
    for (let leaf = s.leaf.next; leaf; leaf = leaf.next) {
      if (leaf.items.length > 0) return leaf.items[0]!;
    }
    return null;
  }

  /** Find the span holding visible char `pos` (0 <= pos < length). */
  private locateVisible(pos: number): Location {
    let node: TreeNode = this.root;
    while (!node.isLeaf) {
      const children: TreeNode[] = node.children;
      let next: TreeNode | undefined;
      for (const c of children) {
        if (pos < c.vis) {
          next = c;
          break;
        }
        pos -= c.vis;
      }
      node = next!;
    }
    const items = node.items;
    for (let i = 0; i < items.length; i++) {
      const s = items[i]!;
      if (s.deleted) continue;
      if (pos < s.len) return { leaf: node, idx: i, offset: pos };
      pos -= s.len;
    }
    throw new Error('locateVisible: position out of range');
  }

  /** Find the span holding raw item `pos` (0 <= pos < rawLength). */
  private locateRaw(pos: number): Location {
    let node: TreeNode = this.root;
    while (!node.isLeaf) {
      const children: TreeNode[] = node.children;
      let next: TreeNode | undefined;
      for (const c of children) {
        if (pos < c.raw) {
          next = c;
          break;
        }
        pos -= c.raw;
      }
      node = next!;
    }
    const items = node.items;
    for (let i = 0; i < items.length; i++) {
      const s = items[i]!;
      if (pos < s.len) return { leaf: node, idx: i, offset: pos };
      pos -= s.len;
    }
    throw new Error('locateRaw: position out of range');
  }

  private rawIndexOf(span: Span): number {
    let idx = 0;
    for (const s of span.leaf.items) {
      if (s === span) break;
      idx += s.len;
    }
    let node: TreeNode = span.leaf;
    for (let p = node.parent; p; node = p, p = p.parent) {
      for (const c of p.children) {
        if (c === node) break;
        idx += c.raw;
      }
    }
    return idx;
  }

  private visIndexOf(span: Span): number {
    let idx = 0;
    for (const s of span.leaf.items) {
      if (s === span) break;
      idx += visLen(s);
    }
    let node: TreeNode = span.leaf;
    for (let p = node.parent; p; node = p, p = p.parent) {
      for (const c of p.children) {
        if (c === node) break;
        idx += c.vis;
      }
    }
    return idx;
  }

  private insertAtRaw(pos: number, span: Span): void {
    if (pos === this.root.raw) {
      let leaf = this.root;
      while (!leaf.isLeaf) leaf = leaf.children[leaf.children.length - 1]!;
      this.insertIntoLeaf(leaf, leaf.items.length, span);
      return;
    }
    const loc = this.locateRaw(pos);
    if (loc.offset === 0) {
      this.insertIntoLeaf(loc.leaf, loc.idx, span);
    } else {
      const left = loc.leaf.items[loc.idx]!;
      this.splitSpan(left, loc.offset);
      this.insertAfter(left, span);
    }
  }

  private insertAfter(left: Span, span: Span): void {
    const leaf = left.leaf;
    this.insertIntoLeaf(leaf, leaf.items.indexOf(left) + 1, span);
  }

  private insertIntoLeaf(leaf: Leaf, idx: number, span: Span): void {
    leaf.items.splice(idx, 0, span);
    span.leaf = leaf;
    this.adjust(leaf, span.len, visLen(span));
    if (leaf.items.length > MAX_FANOUT) this.splitLeaf(leaf);
  }

  /** Add deltas to the cached counts of `leaf` and all its ancestors. */
  private adjust(leaf: Leaf, dRaw: number, dVis: number): void {
    for (let n: TreeNode | null = leaf; n; n = n.parent) {
      n.raw += dRaw;
      n.vis += dVis;
    }
  }

  /**
   * Split span `s` so it keeps its first `offset` chars; the remainder
   * becomes a new span placed right after it. Returns the new right part.
   */
  private splitSpan(s: Span, offset: number): Span {
    const right: Span = {
      agent: s.agent,
      seq: s.seq + offset,
      len: s.len - offset,
      content: s.deleted ? '' : s.content.slice(offset),
      deleted: s.deleted,
      appends: 0,
      olAgent: s.agent,
      olSeq: s.seq + offset - 1,
      orAgent: s.orAgent,
      orSeq: s.orSeq,
      leaf: s.leaf,
      run: s.run,
    };
    s.len = offset;
    if (!s.deleted) s.content = s.content.slice(0, offset);

    const frags = s.run.frags;
    frags.splice(upperBound(frags, s.seq), 0, right);

    // Raw/visible totals are unchanged, so no count adjustment is needed.
    const leaf = s.leaf;
    leaf.items.splice(leaf.items.indexOf(s) + 1, 0, right);
    if (leaf.items.length > MAX_FANOUT) this.splitLeaf(leaf);
    return right;
  }

  private markDeleted(s: Span): void {
    s.deleted = true;
    s.content = '';
    this.adjust(s.leaf, 0, -s.len);
    // Re-coalesce tombstone fragments so repeated deletes don't fragment
    // the tree forever.
    const items = s.leaf.items;
    const i = items.indexOf(s);
    if (i + 1 < items.length && canMerge(s, items[i + 1]!)) this.mergeNext(s.leaf, i);
    if (i > 0 && canMerge(items[i - 1]!, s)) this.mergeNext(s.leaf, i - 1);
  }

  private mergeNext(leaf: Leaf, i: number): void {
    const a = leaf.items[i]!;
    const b = leaf.items[i + 1]!;
    a.len += b.len;
    leaf.items.splice(i + 1, 1);
    const frags = a.run.frags;
    frags.splice(upperBound(frags, b.seq) - 1, 1);
  }

  private splitLeaf(leaf: Leaf): void {
    const right = new Leaf();
    right.items = leaf.items.splice(leaf.items.length >> 1);
    for (const s of right.items) {
      s.leaf = right;
      right.raw += s.len;
      right.vis += visLen(s);
    }
    leaf.raw -= right.raw;
    leaf.vis -= right.vis;
    right.next = leaf.next;
    leaf.next = right;
    this.insertSibling(leaf, right);
  }

  private splitInternal(node: Internal): void {
    const right = new Internal();
    right.children = node.children.splice(node.children.length >> 1);
    for (const c of right.children) {
      c.parent = right;
      right.raw += c.raw;
      right.vis += c.vis;
    }
    node.raw -= right.raw;
    node.vis -= right.vis;
    this.insertSibling(node, right);
  }

  /** Insert `right` (split off from `node`) after `node` in its parent. */
  private insertSibling(node: TreeNode, right: TreeNode): void {
    const parent = node.parent;
    if (!parent) {
      const root = new Internal();
      root.children = [node, right];
      root.raw = node.raw + right.raw;
      root.vis = node.vis + right.vis;
      node.parent = root;
      right.parent = root;
      this.root = root;
      return;
    }
    parent.children.splice(parent.children.indexOf(node) + 1, 0, right);
    right.parent = parent;
    if (parent.children.length > MAX_FANOUT) this.splitInternal(parent);
  }
}

const DUMMY_RUN: Run = { seq: 0, len: 0, frags: [] };

function origins(s: Span): Origins {
  return { olAgent: s.olAgent, olSeq: s.olSeq, orAgent: s.orAgent, orSeq: s.orSeq };
}

/** Two tombstones can merge if `b` is exactly the continuation of `a`. */
function canMerge(a: Span, b: Span): boolean {
  return (
    a.deleted &&
    b.deleted &&
    a.run === b.run &&
    a.seq + a.len === b.seq &&
    b.olAgent === a.agent &&
    b.olSeq === b.seq - 1 &&
    b.orAgent === a.orAgent &&
    b.orSeq === a.orSeq
  );
}

function pushTarget(targets: DeleteTarget[], agent: number, seq: number, len: number): void {
  const last = targets[targets.length - 1];
  if (last && last.agent === agent && last.seq + last.len === seq) last.len += len;
  else targets.push({ agent, seq, len });
}

/** Index of the first element whose `.seq` is greater than `seq`. */
function upperBound(arr: readonly { seq: number }[], seq: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
