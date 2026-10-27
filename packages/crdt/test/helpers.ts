import { expect } from 'vitest';
import { Doc, ROOT, TRASH, decodeOps, encodeOps, type Op } from '../src/index.js';

/** Small deterministic PRNG (mulberry32) for network scheduling. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export interface DocState {
  text: string;
  ids: string[];
  meta: Record<string, unknown>;
  pages: [string, string][];
  version: Record<string, number>;
}

export function state(doc: Doc): DocState {
  return {
    text: doc.text,
    ids: doc.visibleIds(),
    meta: doc.meta(),
    pages: doc.pages(),
    version: doc.version(),
  };
}

/** Every node's ancestor chain must terminate (no cycles). */
export function assertAcyclic(doc: Doc): void {
  const pages = doc.pages();
  for (const [node] of pages) {
    let steps = 0;
    for (let p = doc.pageParent(node); p !== undefined; p = doc.pageParent(p)) {
      if (p === node) throw new Error(`cycle through ${node}`);
      if (++steps > pages.length + 2) throw new Error(`cycle above ${node}`);
    }
  }
}

/** Repeated pairwise anti-entropy until every replica has every op. */
export function syncAll(docs: Doc[]): void {
  for (let round = 0; round < 4; round++) {
    for (const from of docs) {
      for (const to of docs) {
        if (from !== to) to.applyRemote(from.getOps(to.version()));
      }
    }
  }
}

export function assertConverged(docs: Doc[]): void {
  for (const d of docs) expect(d.pending).toBe(0);
  const first = state(docs[0]!);
  for (const d of docs.slice(1)) expect(state(d)).toEqual(first);
}

/**
 * A lossy, reordering, duplicating network between replicas. Messages are
 * batches of ops; `send` snapshots what the sender knows (relative to a
 * possibly stale view of the receiver), drops/duplicates/shuffles it, and
 * queues it. `deliver` picks any queued message whose link isn't
 * partitioned, so messages are delivered out of order.
 */
export class Network {
  readonly queue: { from: number; to: number; bytes: Uint8Array | null; ops: Op[] }[] = [];
  /** group[i] = partition side of replica i; null = fully connected. */
  group: number[] | null = null;
  delivered = 0;

  constructor(
    readonly docs: Doc[],
    private readonly rand: () => number,
  ) {}

  connected(a: number, b: number): boolean {
    return this.group === null || this.group[a] === this.group[b];
  }

  send(from: number, to: number, dropRate: number, staleView: boolean): void {
    const src = this.docs[from]!;
    const since = staleView ? {} : this.docs[to]!.version();
    let ops = src.getOps(since).filter(() => this.rand() >= dropRate);
    // Duplicate some ops and shuffle: delivery order is arbitrary.
    ops = ops.concat(ops.filter(() => this.rand() < 0.2));
    shuffle(ops, this.rand);
    if (ops.length === 0) return;
    // Half of the messages go through the binary encoding.
    const bytes = this.rand() < 0.5 ? encodeOps(ops) : null;
    this.queue.push({ from, to, bytes, ops });
  }

  deliver(pick: number): void {
    const ready = this.queue
      .map((m, i) => [m, i] as const)
      .filter(([m]) => this.connected(m.from, m.to));
    if (ready.length === 0) return;
    const [msg, idx] = ready[pick % ready.length]!;
    this.queue.splice(idx, 1);
    const ops = msg.bytes ? decodeOps(msg.bytes) : msg.ops;
    this.docs[msg.to]!.applyRemote(ops);
    this.delivered++;
  }

  /** Heal partitions, flush every queued message, then anti-entropy. */
  settle(): void {
    this.group = null;
    while (this.queue.length > 0) this.deliver(Math.floor(this.rand() * this.queue.length));
    syncAll(this.docs);
  }
}

export const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
export const PARENTS = [...NODES, ROOT, TRASH];
