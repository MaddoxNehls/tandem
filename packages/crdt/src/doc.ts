/**
 * `Doc`: one replica of a Tandem document. It composes
 *   - a Fugue text sequence (the note body),
 *   - an LWW map (note metadata: title, icon, tags, ...),
 *   - a movable tree (page hierarchy),
 * behind a single Lamport clock, a single op log and a single version vector.
 *
 * ## Causality and delivery
 * Every op has an id (agent, seq) where an agent's seqs are dense. Before an
 * op is applied, `applyRemote` checks its dependencies:
 *   - the agent's previous op (seq - 1), so per-agent ops apply in order;
 *   - every character id it references (insert origins, delete targets).
 * Ops whose dependencies are missing are buffered and retried as soon as
 * the missing agent advances. Ops (or prefixes of ops) we already have are
 * ignored, which makes `applyRemote` idempotent. Together this means peers
 * can send ops in any order, with duplicates, and still converge.
 *
 * Because each agent's ops apply in seq order, the version vector
 * {agent: nextSeq} exactly summarizes a replica's state, and
 * `getOps(theirVersion)` returns exactly what a peer is missing.
 */

import { encodeOps, decodeOps } from './encoding.js';
import { LWWMap, type JsonValue } from './map.js';
import {
  opSpan,
  trimOp,
  validateOp,
  type DeleteOp,
  type DeleteRange,
  type Id,
  type InsertOp,
  type MoveOp,
  type Op,
  type SetOp,
  type VersionVector,
} from './ops.js';
import { FugueText, NONE, type TextPatch } from './text.js';
import { appendFlattening } from './strings.js';
import { MoveTree, ROOT, TRASH } from './tree.js';

/** Thrown by `applyRemote` for an op that can never be applied. */
export class InvalidOpError extends Error {
  override name = 'InvalidOpError';
}

/**
 * A position that survives concurrent edits: the id of the character to the
 * left of the cursor, or null for the start of the document.
 */
export type CursorRef = Id | null;

export interface DocOptions {
  /** Globally unique replica id. Defaults to a random id. */
  agent?: string;
}

export interface ChangeEvent {
  origin: 'local' | 'remote';
  /** The ops that were applied, in application order. */
  ops: Op[];
  /**
   * Text changes in visible-position terms, to be applied in order (each
   * position is relative to the text after the previous patch). This is
   * what an editor binding needs.
   */
  text: TextPatch[];
  /** Metadata keys whose visible value changed. */
  meta: string[];
  /** Whether the page tree may have changed. */
  tree: boolean;
}

export interface ApplyResult {
  /** Ops applied now (including previously buffered ones that unblocked). */
  applied: number;
  /** Ops ignored because they were already applied. */
  duplicates: number;
  /** Ops still buffered waiting for dependencies (across all calls). */
  pending: number;
}

type Listener = (event: ChangeEvent) => void;

interface Blocked {
  op: Op;
  /** The op can be retried once vv[agent] > needSeq. */
  needSeq: number;
}

const APPLIED = 0;
const DUPLICATE = 1;
interface Missing {
  agent: number;
  seq: number;
}

export class Doc {
  readonly agent: string;
  private readonly me: number;
  private readonly agentNames: string[] = [];
  private readonly agentIdx = new Map<string, number>();
  /** vv[agentIndex] = next expected seq from that agent. */
  private readonly vv: number[] = [];
  /** Next Lamport timestamp to assign (greater than any seen). */
  private clock = 0;
  private readonly textCrdt: FugueText;
  private readonly map = new LWWMap();
  private readonly tree = new MoveTree();
  /** All applied ops in a causal order (local ops merged when contiguous). */
  private readonly log: Op[] = [];
  /** Appends merged into the last log entry's content since its last flatten. */
  private lastLogAppends = 0;
  /** Whether the last log entry is a private copy we may mutate. */
  private lastOwned = false;
  /** Buffered ops, keyed by the agent they wait on, sorted by needSeq desc. */
  private readonly waiting = new Map<number, Blocked[]>();
  private pendingCount = 0;
  private readonly listeners = new Set<Listener>();

  constructor(options: DocOptions = {}) {
    const agent = options.agent ?? randomAgent();
    if (typeof agent !== 'string' || agent.length === 0) {
      throw new TypeError('agent must be a non-empty string');
    }
    this.agent = agent;
    this.textCrdt = new FugueText((i) => this.agentNames[i]!);
    this.me = this.intern(agent);
  }

  /** Rebuild a document from `save()` output. */
  static load(bytes: Uint8Array, options: DocOptions = {}): Doc {
    const doc = new Doc(options);
    const result = doc.applyRemote(decodeOps(bytes));
    if (result.pending > 0) throw new Error('snapshot is missing operations');
    return doc;
  }

  /** Full-document snapshot: the complete op history, binary encoded. */
  save(): Uint8Array {
    return encodeOps(this.log, { snapshot: true });
  }

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------

  get text(): string {
    return this.textCrdt.toString();
  }

  get length(): number {
    return this.textCrdt.length;
  }

  insert(pos: number, text: string): void {
    if (text.length === 0) {
      if (!Number.isInteger(pos) || pos < 0 || pos > this.length) {
        throw new RangeError(`insert position ${pos} out of range [0, ${this.length}]`);
      }
      return;
    }
    const seq = this.vv[this.me]!;
    const lamport = this.clock;
    const o = this.textCrdt.localInsert(this.me, seq, pos, text);
    const op: InsertOp = {
      kind: 'ins',
      agent: this.agent,
      seq,
      lamport,
      originLeft: this.idOf(o.olAgent, o.olSeq),
      originRight: this.idOf(o.orAgent, o.orSeq),
      content: text,
    };
    this.commitLocal(op, { text: [{ type: 'insert', pos, text }] });
  }

  delete(pos: number, len: number): void {
    const targets = this.textCrdt.localDelete(pos, len);
    if (targets.length === 0) return;
    const op: DeleteOp = {
      kind: 'del',
      agent: this.agent,
      seq: this.vv[this.me]!,
      lamport: this.clock,
      targets: targets.map((t) => ({ agent: this.agentNames[t.agent]!, seq: t.seq, len: t.len })),
    };
    this.commitLocal(op, { text: [{ type: 'delete', pos, len }] });
  }

  /** Stable reference for cursor position `pos` (0..length). */
  cursorAt(pos: number): CursorRef {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.length) {
      throw new RangeError(`cursor position ${pos} out of range [0, ${this.length}]`);
    }
    if (pos === 0) return null;
    const id = this.textCrdt.idAtVisible(pos - 1);
    return { agent: this.agentNames[id.agent]!, seq: id.seq };
  }

  /**
   * Current position of a cursor reference, or null if it refers to a
   * character this replica has not received yet.
   */
  resolveCursor(ref: CursorRef): number | null {
    if (ref === null) return 0;
    const a = this.agentIdx.get(ref.agent);
    if (a === undefined || !this.textCrdt.hasRange(a, ref.seq, 1)) return null;
    return this.textCrdt.visibleOffsetAfter(a, ref.seq);
  }

  /** Visible character ids in order, as "agent:seq" strings (debug/testing). */
  visibleIds(): string[] {
    return this.textCrdt.visibleIds();
  }

  /** All characters in list order, including deleted ones (`ch` '' for those). */
  allChars(): { id: string; ch: string; visible: boolean }[] {
    return this.textCrdt.allChars();
  }

  // ---------------------------------------------------------------------------
  // Metadata (LWW map)
  // ---------------------------------------------------------------------------

  getMeta(key: string): JsonValue | undefined {
    return this.map.get(key);
  }

  /** Set a metadata key; `undefined` deletes it. */
  setMeta(key: string, value: JsonValue | undefined): void {
    const op: SetOp = {
      kind: 'set',
      agent: this.agent,
      seq: this.vv[this.me]!,
      lamport: this.clock,
      key,
      value,
    };
    this.commitLocal(op, { meta: [key] });
  }

  meta(): Record<string, JsonValue> {
    return this.map.toJSON();
  }

  // ---------------------------------------------------------------------------
  // Page tree
  // ---------------------------------------------------------------------------

  /**
   * Move (or create) page `node` under `parent`. Returns false, without
   * generating an op, if the move would create a cycle.
   */
  movePage(node: string, parent: string = ROOT): boolean {
    if (node === ROOT || node === TRASH) throw new RangeError(`cannot move ${node}`);
    if (this.tree.wouldCycle(node, parent)) return false;
    const op: MoveOp = {
      kind: 'move',
      agent: this.agent,
      seq: this.vv[this.me]!,
      lamport: this.clock,
      node,
      parent,
    };
    this.commitLocal(op, { tree: true });
    return true;
  }

  /** Delete a page (moves it, with its subtree, to the trash). */
  deletePage(node: string): void {
    this.movePage(node, TRASH);
  }

  pageParent(node: string): string | undefined {
    return this.tree.parentOf(node);
  }

  pageChildren(parent: string = ROOT): string[] {
    return this.tree.children(parent);
  }

  isPageLive(node: string): boolean {
    return this.tree.isLive(node);
  }

  /** Every node with its parent, sorted by node id. */
  pages(): [string, string][] {
    return this.tree.entries();
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** Version vector: agent -> number of seqs applied from that agent. */
  version(): VersionVector {
    const out: VersionVector = {};
    this.agentNames.forEach((name, i) => {
      const n = this.vv[i]!;
      if (n > 0) out[name] = n;
    });
    return out;
  }

  /** Ops a peer at version `since` is missing, in causal order. */
  getOps(since: VersionVector = {}): Op[] {
    const out: Op[] = [];
    const lastIdx = this.log.length - 1;
    this.log.forEach((op, i) => {
      const have = since[op.agent] ?? 0;
      if (have >= op.seq + opSpan(op)) return;
      if (have > op.seq) out.push(trimOp(op, have - op.seq));
      else out.push(i === lastIdx && this.lastOwned ? cloneOp(op) : op);
    });
    return out;
  }

  /** Number of received ops buffered while waiting for their dependencies. */
  get pending(): number {
    return this.pendingCount;
  }

  /**
   * Apply ops from other replicas. Safe to call with ops in any order, with
   * duplicates, or with ops whose dependencies have not arrived yet (they are
   * buffered until they can be applied).
   */
  applyRemote(ops: readonly Op[]): ApplyResult {
    // Reject a malformed batch up front, before anything is applied.
    for (const op of ops) {
      const err = validateOp(op);
      if (err) throw new InvalidOpError(`invalid op: ${err}`);
    }
    const event: ChangeEvent | null =
      this.listeners.size > 0
        ? { origin: 'remote', ops: [], text: [], meta: [], tree: false }
        : null;
    let applied = 0;
    let duplicates = 0;
    const queue: Op[] = ops.slice();
    try {
      for (let qi = 0; qi < queue.length; qi++) {
        const op = queue[qi]!;
        // Each op is atomic: an InvalidOpError (an op referencing ids that
        // are not characters) leaves earlier ops applied and this one not.
        const res = this.tryApply(op, event);
        if (res === APPLIED) {
          applied++;
          this.wake(this.agentIdx.get(op.agent)!, queue);
        } else if (res === DUPLICATE) {
          duplicates++;
        } else {
          this.block(op, res);
        }
      }
    } finally {
      if (event && applied > 0) this.emit(event);
    }
    return { applied, duplicates, pending: this.pendingCount };
  }

  /** Subscribe to change events; returns an unsubscribe function. */
  on(_event: 'change', listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Internal statistics (benchmarks). */
  stats(): { ops: number; spans: number; btreeDepth: number; rawLength: number; treeLog: number } {
    const text = this.textCrdt.stats();
    return {
      ops: this.log.length,
      spans: text.spans,
      btreeDepth: text.depth,
      rawLength: this.textCrdt.rawLength,
      treeLog: this.tree.logLength,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private intern(agent: string): number {
    let i = this.agentIdx.get(agent);
    if (i === undefined) {
      i = this.agentNames.length;
      this.agentNames.push(agent);
      this.agentIdx.set(agent, i);
      this.vv.push(0);
    }
    return i;
  }

  private idOf(agent: number, seq: number): Id | null {
    return agent === NONE ? null : { agent: this.agentNames[agent]!, seq };
  }

  private commitLocal(op: Op, changes: Partial<Omit<ChangeEvent, 'origin' | 'ops'>>): void {
    // Apply to the sub-CRDT (text ops were already applied by the caller).
    if (op.kind === 'set') this.map.apply(op.key, op.value, op.lamport, op.agent);
    else if (op.kind === 'move') this.tree.apply(op.lamport, op.agent, op.node, op.parent);

    const span = opSpan(op);
    this.vv[this.me]! += span;
    this.clock += span;
    this.appendLocalToLog(op);
    if (this.listeners.size > 0) {
      this.emit({
        origin: 'local',
        ops: [op],
        text: changes.text ?? [],
        meta: changes.meta ?? [],
        tree: changes.tree ?? false,
      });
    }
  }

  /**
   * Append a local op, run-length merging it into the previous log entry
   * when it simply continues it (typing forwards, or repeated deletes).
   *
   * Ops passed in or handed out (events, getOps) must never change under
   * the caller, so the first merge replaces the last entry with a private
   * copy (`lastOwned`), and later merges mutate that copy in place.
   * `getOps` hands out a snapshot of an owned last entry.
   */
  private appendLocalToLog(op: Op): void {
    const n = this.log.length;
    const last = this.log[n - 1];
    if (last && last.agent === op.agent && last.kind === op.kind) {
      const span = opSpan(last);
      if (last.seq + span === op.seq && last.lamport + span === op.lamport) {
        if (
          last.kind === 'ins' &&
          op.kind === 'ins' &&
          op.originLeft?.agent === op.agent &&
          op.originLeft.seq === op.seq - 1 &&
          sameId(last.originRight, op.originRight)
        ) {
          const entry = this.ownLast(last) as InsertOp;
          [entry.content, this.lastLogAppends] = appendFlattening(entry.content, op.content, this.lastLogAppends);
          return;
        }
        if (last.kind === 'del' && op.kind === 'del') {
          const entry = this.ownLast(last) as DeleteOp;
          for (const t of op.targets) pushRange(entry.targets, t);
          return;
        }
      }
    }
    this.log.push(op);
    this.lastOwned = false;
    this.lastLogAppends = 0;
  }

  private ownLast(last: Op): Op {
    if (this.lastOwned) return last;
    const copy = cloneOp(last);
    this.log[this.log.length - 1] = copy;
    this.lastOwned = true;
    return copy;
  }

  private tryApply(input: Op, event: ChangeEvent | null): typeof APPLIED | typeof DUPLICATE | Missing {
    const a = this.intern(input.agent);
    const have = this.vv[a]!;
    const span = opSpan(input);
    if (have >= input.seq + span) return DUPLICATE;
    if (have < input.seq) return { agent: a, seq: input.seq - 1 };
    const op = have > input.seq ? trimOp(input, have - input.seq) : input;
    const opSpanNow = opSpan(op);

    const missing = this.missingDependency(op);
    if (missing) return missing;
    this.assertReferencesExist(op);

    switch (op.kind) {
      case 'ins': {
        const pos = this.textCrdt.remoteInsert(
          a,
          op.seq,
          op.content,
          {
            olAgent: op.originLeft ? this.intern(op.originLeft.agent) : NONE,
            olSeq: op.originLeft?.seq ?? 0,
            orAgent: op.originRight ? this.intern(op.originRight.agent) : NONE,
            orSeq: op.originRight?.seq ?? 0,
          },
          event !== null,
        );
        event?.text.push({ type: 'insert', pos, text: op.content });
        break;
      }
      case 'del':
        this.textCrdt.remoteDelete(
          op.targets.map((t) => ({ agent: this.intern(t.agent), seq: t.seq, len: t.len })),
          event ? event.text : null,
        );
        break;
      case 'set':
        if (this.map.apply(op.key, op.value, op.lamport, op.agent)) event?.meta.push(op.key);
        break;
      case 'move':
        // ROOT and TRASH are fixed; a move of them is malformed and ignored
        // (still recorded, so version vectors stay consistent).
        if (op.node !== ROOT && op.node !== TRASH) {
          this.tree.apply(op.lamport, op.agent, op.node, op.parent);
          if (event) event.tree = true;
        }
        break;
    }

    this.vv[a] = op.seq + opSpanNow;
    this.clock = Math.max(this.clock, op.lamport + opSpanNow);
    this.log.push(op);
    this.lastOwned = false;
    this.lastLogAppends = 0;
    event?.ops.push(op);
    return APPLIED;
  }

  /** First character id `op` references that we don't have yet, if any. */
  private missingDependency(op: Op): Missing | null {
    const check = (agent: string, seq: number): Missing | null => {
      const a = this.intern(agent);
      return this.vv[a]! > seq ? null : { agent: a, seq };
    };
    if (op.kind === 'ins') {
      if (op.originLeft) {
        const m = check(op.originLeft.agent, op.originLeft.seq);
        if (m) return m;
      }
      if (op.originRight) return check(op.originRight.agent, op.originRight.seq);
    } else if (op.kind === 'del') {
      for (const t of op.targets) {
        const m = check(t.agent, t.seq + t.len - 1);
        if (m) return m;
      }
    }
    return null;
  }

  /**
   * Every referenced id is covered by the version vector, but it must also
   * be a *character*: an id that belongs to a map or tree op would make the
   * text CRDT fail half-way through. Checked before any state changes.
   */
  private assertReferencesExist(op: Op): void {
    const ok = (agent: string, seq: number, len: number): boolean =>
      this.textCrdt.hasRange(this.intern(agent), seq, len);
    if (op.kind === 'ins') {
      if (op.originLeft && !ok(op.originLeft.agent, op.originLeft.seq, 1)) {
        throw new InvalidOpError(`insert ${op.agent}:${op.seq} has a non-character originLeft`);
      }
      if (op.originRight && !ok(op.originRight.agent, op.originRight.seq, 1)) {
        throw new InvalidOpError(`insert ${op.agent}:${op.seq} has a non-character originRight`);
      }
    } else if (op.kind === 'del') {
      for (const t of op.targets) {
        if (!ok(t.agent, t.seq, t.len)) {
          throw new InvalidOpError(`delete ${op.agent}:${op.seq} targets non-character ids`);
        }
      }
    }
  }

  private block(op: Op, missing: Missing): void {
    let list = this.waiting.get(missing.agent);
    if (!list) {
      list = [];
      this.waiting.set(missing.agent, list);
    }
    // Keep sorted by needSeq descending so ready ops pop off the end.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.needSeq > missing.seq) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, { op, needSeq: missing.seq });
    this.pendingCount++;
  }

  /** Move ops that were waiting on `agent` and are now unblocked to `queue`. */
  private wake(agent: number, queue: Op[]): void {
    const list = this.waiting.get(agent);
    if (!list) return;
    const have = this.vv[agent]!;
    while (list.length > 0 && list[list.length - 1]!.needSeq < have) {
      queue.push(list.pop()!.op);
      this.pendingCount--;
    }
    if (list.length === 0) this.waiting.delete(agent);
  }

  private emit(event: ChangeEvent): void {
    for (const l of this.listeners) l(event);
  }
}

function cloneOp(op: Op): Op {
  return op.kind === 'del' ? { ...op, targets: op.targets.map((t) => ({ ...t })) } : { ...op };
}

function sameId(a: Id | null, b: Id | null): boolean {
  return a === null || b === null ? a === b : a.agent === b.agent && a.seq === b.seq;
}

/**
 * Append a range to a delete op's targets, coalescing with the last range
 * when the units stay in order: forwards (delete key: next range starts
 * where the last ended) or backwards (backspace: next range ends where the
 * last started, giving a `rev` range).
 */
function pushRange(targets: DeleteRange[], t: DeleteRange): void {
  const last = targets[targets.length - 1];
  if (last && last.agent === t.agent) {
    const lastAsc = !last.rev || last.len === 1;
    const tAsc = !t.rev || t.len === 1;
    const lastDesc = last.rev === true || last.len === 1;
    const tDesc = t.rev === true || t.len === 1;
    if (lastAsc && tAsc && last.seq + last.len === t.seq) {
      last.len += t.len; // last.rev is unset here: rev ranges have len >= 2
      return;
    }
    if (lastDesc && tDesc && t.seq + t.len === last.seq) {
      last.seq = t.seq;
      last.len += t.len;
      last.rev = true;
      return;
    }
  }
  targets.push({ ...t });
}

function randomAgent(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
