/**
 * Wire-level operations. Every op has an id (agent, seq) and a Lamport
 * timestamp. An op occupies `opSpan(op)` consecutive seqs and Lamport
 * values: a text insert of k characters uses seqs seq..seq+k-1 (one id per
 * character), a delete of k characters uses k seqs, and map/tree ops use 1.
 *
 * Because an agent's seqs are dense (0, 1, 2, ...) and each replica applies
 * an agent's ops in seq order, a version vector {agent: nextSeq} exactly
 * describes which ops a replica has.
 */

import type { JsonValue } from './map.js';

export interface Id {
  agent: string;
  seq: number;
}

export interface OpBase {
  agent: string;
  seq: number;
  lamport: number;
}

/** Insert `content` between originLeft and originRight (null = doc edge). */
export interface InsertOp extends OpBase {
  kind: 'ins';
  originLeft: Id | null;
  originRight: Id | null;
  content: string;
}

/**
 * The characters (agent, seq) .. (agent, seq + len - 1). The op's units map
 * onto its ranges' characters in order: ascending seq, or descending seq
 * when `rev` is set. `rev` lets a run of backspaces, which deletes
 * characters right-to-left, be stored as one range instead of one range per
 * keystroke. It only matters when trimming a partially-seen op.
 */
export interface DeleteRange {
  agent: string;
  seq: number;
  len: number;
  rev?: boolean;
}

/** Delete the characters with the given ids. */
export interface DeleteOp extends OpBase {
  kind: 'del';
  targets: DeleteRange[];
}

/** Write a metadata register; `value: undefined` deletes the key. */
export interface SetOp extends OpBase {
  kind: 'set';
  key: string;
  value: JsonValue | undefined;
}

/** Move (or create) tree node `node` under `parent`. */
export interface MoveOp extends OpBase {
  kind: 'move';
  node: string;
  parent: string;
}

export type Op = InsertOp | DeleteOp | SetOp | MoveOp;

/** agent -> number of seqs seen from that agent (i.e. its next seq). */
export type VersionVector = Record<string, number>;

export function opSpan(op: Op): number {
  switch (op.kind) {
    case 'ins':
      return op.content.length;
    case 'del': {
      let n = 0;
      for (const t of op.targets) n += t.len;
      return n;
    }
    default:
      return 1;
  }
}

/**
 * Drop the first `n` units of a multi-unit op (0 < n < span). Used when a
 * peer re-sends an op we have partially seen, e.g. because ops were merged
 * differently on the way.
 */
export function trimOp(op: Op, n: number): Op {
  switch (op.kind) {
    case 'ins':
      return {
        ...op,
        seq: op.seq + n,
        lamport: op.lamport + n,
        originLeft: { agent: op.agent, seq: op.seq + n - 1 },
        content: op.content.slice(n),
      };
    case 'del': {
      const targets: DeleteRange[] = [];
      let skip = n;
      for (const t of op.targets) {
        if (skip >= t.len) {
          skip -= t.len;
          continue;
        }
        // Dropping the first `skip` units removes the lowest chars of an
        // ascending range, or the highest chars of a reversed one.
        targets.push(
          t.rev
            ? { agent: t.agent, seq: t.seq, len: t.len - skip, rev: true }
            : { agent: t.agent, seq: t.seq + skip, len: t.len - skip },
        );
        skip = 0;
      }
      return { ...op, seq: op.seq + n, lamport: op.lamport + n, targets };
    }
    default:
      throw new Error(`cannot trim a ${op.kind} op`);
  }
}

/** Limits enforced by `validateOp` on ops from untrusted peers. */
export const LIMITS = {
  agentLength: 64,
  /** Lamport times and seqs must stay well inside safe-integer range. */
  maxCounter: 2 ** 48,
  maxInsertLength: 1 << 20,
  maxDeleteTargets: 1 << 16,
  maxDeleteSpan: 1 << 22,
  keyLength: 256,
  nodeIdLength: 128,
  maxValueJsonLength: 1 << 16,
} as const;

const isCounter = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < LIMITS.maxCounter;
const isAgent = (a: unknown): a is string =>
  typeof a === 'string' && a.length > 0 && a.length <= LIMITS.agentLength;

function checkId(id: unknown, op: { agent: string; seq: number }, what: string): string | null {
  if (id === null) return null;
  if (typeof id !== 'object') return `${what} must be an object or null`;
  const { agent, seq } = id as Record<string, unknown>;
  if (!isAgent(agent) || !isCounter(seq)) return `${what} is malformed`;
  // An op can only depend on its own agent's earlier seqs.
  if (agent === op.agent && seq >= op.seq) return `${what} refers to the op itself or its future`;
  return null;
}

/**
 * Structural validation of an op received from an untrusted peer: types,
 * bounds and self-consistency. Returns an error message, or null if the op
 * is well-formed. (Whether referenced ids exist is checked by `applyRemote`,
 * which needs the document state.)
 */
export function validateOp(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return 'op must be an object';
  const op = input as Record<string, unknown>;
  if (!isAgent(op.agent)) return 'bad agent';
  if (!isCounter(op.seq)) return 'bad seq';
  if (!isCounter(op.lamport)) return 'bad lamport';
  const base = { agent: op.agent, seq: op.seq };
  switch (op.kind) {
    case 'ins': {
      if (typeof op.content !== 'string' || op.content.length === 0) return 'insert content must be a non-empty string';
      if (op.content.length > LIMITS.maxInsertLength) return 'insert too long';
      if (!isCounter(op.seq + op.content.length) || !isCounter(op.lamport + op.content.length)) return 'insert overflows counters';
      return checkId(op.originLeft, base, 'originLeft') ?? checkId(op.originRight, base, 'originRight');
    }
    case 'del': {
      if (!Array.isArray(op.targets) || op.targets.length === 0) return 'delete needs targets';
      if (op.targets.length > LIMITS.maxDeleteTargets) return 'too many delete targets';
      let span = 0;
      for (const t of op.targets as unknown[]) {
        if (typeof t !== 'object' || t === null) return 'bad delete target';
        const { agent, seq, len, rev } = t as Record<string, unknown>;
        if (!isAgent(agent) || !isCounter(seq) || !isCounter(len) || len === 0) return 'bad delete target';
        if (rev !== undefined && typeof rev !== 'boolean') return 'bad delete target';
        if (agent === op.agent && seq + len > op.seq) return 'delete targets the op itself or its future';
        span += len;
      }
      if (span > LIMITS.maxDeleteSpan || !isCounter(op.seq + span) || !isCounter(op.lamport + span)) return 'delete too large';
      return null;
    }
    case 'set': {
      if (typeof op.key !== 'string' || op.key.length > LIMITS.keyLength) return 'bad key';
      if (op.value === undefined) return null;
      let json: string | undefined;
      try {
        json = JSON.stringify(op.value);
      } catch {
        return 'value is not JSON';
      }
      if (json === undefined || json.length > LIMITS.maxValueJsonLength) return 'bad value';
      return null;
    }
    case 'move': {
      for (const f of [op.node, op.parent]) {
        if (typeof f !== 'string' || f.length === 0 || f.length > LIMITS.nodeIdLength) return 'bad tree node id';
      }
      return null;
    }
    default:
      return 'unknown op kind';
  }
}
