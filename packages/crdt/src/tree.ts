/**
 * Replicated tree with a move operation, after Kleppmann, Mulligan,
 * Gomes, Beresford: "A highly-available move operation for replicated
 * trees" (IEEE TPDS 2021).
 *
 * The only operation is `move(ts, node, newParent)`. Creating a node is a
 * move of a not-yet-seen node; deleting is a move under the TRASH node.
 *
 * Concurrent moves can create cycles (A under B on one replica, B under A on
 * another). The algorithm avoids them by processing all moves in one global
 * timestamp order (lamport, agent) and *skipping* any move whose new parent
 * is the node itself or one of its descendants at that point in the order.
 *
 * Moves arrive in arbitrary order, so to apply a move with timestamp t we
 *   1. undo every logged move with timestamp > t (newest first),
 *   2. apply the new move (or skip it, if it would create a cycle),
 *   3. redo the undone moves in timestamp order, re-checking each for cycles.
 * Each log entry stores the node's parent *before* the move, which is all
 * undo needs. The result is that every replica's tree equals the tree
 * obtained by applying all moves sequentially in timestamp order, so
 * replicas converge and the tree is acyclic after every step.
 *
 * Cost: a move older than k logged moves costs O(k * depth). In practice
 * most ops arrive roughly in timestamp order, so k is small.
 */

import { timestampGreater } from './map.js';

/** Parent of top-level pages. */
export const ROOT = 'root';
/** Parent of deleted pages (a deleted subtree stays restorable). */
export const TRASH = 'trash';

interface MoveRecord {
  lamport: number;
  agent: string;
  node: string;
  parent: string;
  /** Parent before this move was applied; undefined if node didn't exist. */
  oldParent: string | undefined;
}

export class MoveTree {
  private readonly parents = new Map<string, string>();
  private readonly childSets = new Map<string, Set<string>>();
  /** Every applied move, sorted ascending by (lamport, agent). */
  private readonly log: MoveRecord[] = [];

  apply(lamport: number, agent: string, node: string, parent: string): void {
    const undone: MoveRecord[] = [];
    for (;;) {
      const last = this.log[this.log.length - 1];
      if (!last || !timestampGreater(last.lamport, last.agent, lamport, agent)) break;
      this.log.pop();
      this.setParent(last.node, last.oldParent);
      undone.push(last);
    }
    this.doMove({ lamport, agent, node, parent, oldParent: undefined });
    for (let i = undone.length - 1; i >= 0; i--) this.doMove(undone[i]!);
  }

  /** Whether moving `node` under `parent` right now would create a cycle. */
  wouldCycle(node: string, parent: string): boolean {
    return node === parent || this.isAncestor(node, parent);
  }

  parentOf(node: string): string | undefined {
    return this.parents.get(node);
  }

  /** Children of `parent`, sorted by id for deterministic order. */
  children(parent: string): string[] {
    const set = this.childSets.get(parent);
    return set ? [...set].sort() : [];
  }

  /** True if the node exists and is not inside the trash. */
  isLive(node: string): boolean {
    for (let p = this.parents.get(node); p !== undefined; p = this.parents.get(p)) {
      if (p === TRASH) return false;
      if (p === ROOT) return true;
    }
    return false;
  }

  /** All known nodes with their parents, sorted by node id. */
  entries(): [string, string][] {
    return [...this.parents.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Number of logged moves (the log is kept for undo/redo). */
  get logLength(): number {
    return this.log.length;
  }

  private doMove(rec: MoveRecord): void {
    rec.oldParent = this.parents.get(rec.node);
    if (!this.wouldCycle(rec.node, rec.parent)) this.setParent(rec.node, rec.parent);
    this.log.push(rec);
  }

  /** True if `anc` is `node` or one of its ancestors. */
  private isAncestor(anc: string, node: string): boolean {
    for (let p: string | undefined = node; p !== undefined; p = this.parents.get(p)) {
      if (p === anc) return true;
    }
    return false;
  }

  private setParent(node: string, parent: string | undefined): void {
    const old = this.parents.get(node);
    if (old === parent) return;
    if (old !== undefined) this.childSets.get(old)?.delete(node);
    if (parent === undefined) {
      this.parents.delete(node);
      return;
    }
    this.parents.set(node, parent);
    let set = this.childSets.get(parent);
    if (!set) {
      set = new Set();
      this.childSets.set(parent, set);
    }
    set.add(node);
  }
}
