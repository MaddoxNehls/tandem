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
