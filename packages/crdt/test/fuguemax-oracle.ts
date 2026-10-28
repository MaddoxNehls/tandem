/**
 * A deliberately naive, paper-faithful FugueMax, used only as a test
 * oracle. It follows Weidner & Kleppmann, "The Art of the Fugue"
 * (arXiv:2305.00583v3): Algorithm 1 (Fugue) with the two changes of
 * Definition 6 (FugueMax). One node per character, an explicit tree, and an
 * O(n) traversal on every operation. Correctness by inspection, not speed.
 *
 *  - State: a tree; each node has a parent and a side (L or R).
 *  - List order: depth-first in-order traversal (left children, node,
 *    right children).
 *  - Left siblings: ordered by ID.
 *  - Right siblings (FugueMax): ordered by the *reverse* list order of their
 *    right origins, ties broken by ID.
 *  - insert(i, x): leftOrigin = visible element i-1 (or root); rightOrigin
 *    = next node after leftOrigin in the traversal including tombstones (or
 *    end). If leftOrigin has no right children, the new node is a right
 *    child of leftOrigin (tagged with rightOrigin); otherwise it is a left
 *    child of rightOrigin.
 */

const ROOT = '\u0000root';
const END = '\u0000end';

export interface OracleNode {
  id: string;
  agent: string;
  seq: number;
  value: string;
  parent: string;
  side: 'L' | 'R';
  /** Right origin; only meaningful for right children. */
  rightOrigin: string;
}

interface TreeNode extends OracleNode {
  deleted: boolean;
  left: string[];
  right: string[];
}

/** Lexicographic order on IDs (replica id, then counter). */
function idLess(a: TreeNode, b: TreeNode): boolean {
  return a.agent < b.agent || (a.agent === b.agent && a.seq < b.seq);
}

export class FugueMaxOracle {
  private readonly nodes = new Map<string, TreeNode>();
  /** Every node this replica has, in delivery order (a causal order). */
  readonly delivered: OracleNode[] = [];

  constructor() {
    this.nodes.set(ROOT, this.makeTreeNode({ id: ROOT, agent: '', seq: -1, value: '', parent: '', side: 'R', rightOrigin: END }));
    this.nodes.get(ROOT)!.deleted = true;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Full traversal including tombstones (root excluded). */
  traversal(): TreeNode[] {
    const out: TreeNode[] = [];
    const visit = (id: string): void => {
      const n = this.nodes.get(id)!;
      for (const c of n.left) visit(c);
      if (id !== ROOT) out.push(n);
      for (const c of n.right) visit(c);
    };
    visit(ROOT);
    return out;
  }

  visibleIds(): string[] {
    return this.traversal()
      .filter((n) => !n.deleted)
      .map((n) => n.id);
  }

  text(): string {
    return this.traversal()
      .filter((n) => !n.deleted)
      .map((n) => n.value)
      .join('');
  }

  /** Local insert of one character at visible index i (Algorithm 1). */
  insert(i: number, value: string, agent: string, seq: number): OracleNode {
    const all = this.traversal();
    const visible = all.filter((n) => !n.deleted);
    const leftOrigin = i === 0 ? this.nodes.get(ROOT)! : visible[i - 1]!;
    const loIdx = leftOrigin.id === ROOT ? -1 : all.indexOf(leftOrigin);
    const rightOrigin = all[loIdx + 1]?.id ?? END;
    const id = `${agent}:${seq}`;
    const node: OracleNode =
      leftOrigin.right.length === 0
        ? { id, agent, seq, value, parent: leftOrigin.id, side: 'R', rightOrigin }
        : { id, agent, seq, value, parent: rightOrigin, side: 'L', rightOrigin };
    this.deliver(node);
    return node;
  }

  delete(i: number): string {
    const n = this.traversal().filter((x) => !x.deleted)[i]!;
    n.deleted = true;
    return n.id;
  }

  deleteById(id: string): void {
    this.nodes.get(id)!.deleted = true;
  }

  /** Deliver an insert (causal order assumed: parent and origin exist). */
  deliver(node: OracleNode): void {
    if (this.nodes.has(node.id)) return;
    const parent = this.nodes.get(node.parent);
    if (!parent) throw new Error(`oracle: parent ${node.parent} missing`);
    const n = this.makeTreeNode(node);
    this.nodes.set(node.id, n);
    if (node.side === 'L') {
      const sibs = parent.left;
      let k = 0;
      while (k < sibs.length && idLess(this.nodes.get(sibs[k]!)!, n)) k++;
      sibs.splice(k, 0, node.id);
    } else {
      // FugueMax (Definition 6): least index k such that
      //   node.rightOrigin > sibs[k].rightOrigin in list order, or
      //   equal right origins and node.id < sibs[k].id.
      const order = new Map(this.traversal().map((t, idx) => [t.id, idx]));
      const pos = (id: string): number => (id === END ? Number.POSITIVE_INFINITY : order.get(id)!);
      const sibs = parent.right;
      let k = 0;
      for (; k < sibs.length; k++) {
        const s = this.nodes.get(sibs[k]!)!;
        const a = pos(node.rightOrigin);
        const b = pos(s.rightOrigin);
        if (a > b || (a === b && idLess(n, s))) break;
      }
      sibs.splice(k, 0, node.id);
    }
    this.delivered.push(node);
  }

  private makeTreeNode(n: OracleNode): TreeNode {
    return { ...n, deleted: false, left: [], right: [] };
  }
}
