/**
 * On-device search index: semantic (embeddings) blended with keywords.
 *
 *   update(page)  chunk -> look up vectors by content hash (memory, then
 *                 IndexedDB) -> embed only the missing chunks -> store them
 *   search(q)     embed q; per page, semantic = best chunk cosine,
 *                 keyword = weighted term coverage of title and body;
 *                 score = 0.6 * semantic + 0.4 * keyword
 *   related(page) cosine between pages' mean chunk vectors
 *
 * The embedder is pluggable: the app uses a transformers.js model in a Web
 * Worker, and tests use a deterministic fake. If the model isn't ready yet
 * (first download) or failed, search silently degrades to keywords.
 */
import { chunkPage, type Chunk } from './chunk.js';

export interface Embedder {
  /** Identifies the model; part of every cached vector's key. */
  readonly model: string;
  /** Unit-length vectors, one per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface VectorStore {
  get(keys: string[]): Promise<(Float32Array | undefined)[]>;
  put(entries: [string, Float32Array][]): Promise<void>;
  /** Delete every stored key not in `keep`. */
  prune(keep: Set<string>): Promise<number>;
}

export interface SearchResult {
  pageId: string;
  title: string;
  score: number;
  semantic: number;
  keyword: number;
  /** Most relevant line, for display. */
  snippet: string;
}

export interface RelatedPage {
  pageId: string;
  title: string;
  similarity: number;
}

interface PageEntry {
  title: string;
  text: string;
  chunks: Chunk[];
}

export const SEMANTIC_WEIGHT = 0.6;
/** Scaled semantic score a result needs when no query word matches (cosine ≈ 0.3). */
const MIN_SEMANTIC_ONLY = 0.3;
/** Cosine values from small sentence models rarely go below ~0.1 for unrelated text. */
const COS_FLOOR = 0.15;
const COS_CEIL = 0.65;

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are unit length
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Fraction of query terms found: a term in the title counts 1, in the body
 * 0.6. The last term also matches as a prefix (search-as-you-type).
 */
export function keywordScore(query: string, title: string, text: string): number {
  const terms = tokenize(query).filter((t) => t.length > 1);
  if (terms.length === 0) return 0;
  const titleWords = tokenize(title);
  const bodyWords = new Set(tokenize(text));
  let sum = 0;
  terms.forEach((t, i) => {
    const prefix = i === terms.length - 1;
    const hit = (w: string) => w === t || (prefix && w.startsWith(t));
    if (titleWords.some(hit)) sum += 1;
    else if (bodyWords.has(t) || (prefix && [...bodyWords].some(hit))) sum += 0.6;
  });
  return sum / terms.length;
}

const semanticScale = (cos: number) => Math.min(1, Math.max(0, (cos - COS_FLOOR) / (COS_CEIL - COS_FLOOR)));

export class SearchIndex {
  private readonly pages = new Map<string, PageEntry>();
  private readonly vectors = new Map<string, Float32Array>();
  /** Chunks embedded by the model so far (for tests and the UI). */
  embeddedCount = 0;

  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
  ) {}

  private key(hash: string): string {
    return `${this.embedder.model}:${hash}`;
  }

  /** (Re)index a page. Only chunks whose text has no vector yet are embedded. */
  async update(pageId: string, title: string, text: string): Promise<{ embedded: number; reused: number }> {
    const chunks = chunkPage(title, text);
    this.pages.set(pageId, { title, text, chunks });

    const missing = [...new Set(chunks.map((c) => c.hash))].filter((h) => !this.vectors.has(h));
    const reused = chunks.length - missing.length;
    if (missing.length === 0) return { embedded: 0, reused };

    const stored = await this.store.get(missing.map((h) => this.key(h)));
    const toEmbed: string[] = [];
    missing.forEach((h, i) => {
      const v = stored[i];
      if (v) this.vectors.set(h, v);
      else toEmbed.push(h);
    });
    if (toEmbed.length > 0) {
      const texts = toEmbed.map((h) => chunks.find((c) => c.hash === h)!.text);
      const vecs = await this.embedder.embed(texts);
      toEmbed.forEach((h, i) => this.vectors.set(h, vecs[i]!));
      await this.store.put(toEmbed.map((h, i) => [this.key(h), vecs[i]!]));
      this.embeddedCount += toEmbed.length;
    }
    return { embedded: toEmbed.length, reused: chunks.length - toEmbed.length };
  }

  remove(pageId: string): void {
    this.pages.delete(pageId);
  }

  has(pageId: string): boolean {
    return this.pages.has(pageId);
  }

  /** Drop stored vectors no page uses any more. */
  prune(): Promise<number> {
    const keep = new Set<string>();
    for (const p of this.pages.values()) for (const c of p.chunks) keep.add(this.key(c.hash));
    return this.store.prune(keep);
  }

  /**
   * Blended search. Pass `semantic: false` (or let embedding fail) for
   * keyword-only results.
   */
  async search(query: string, opts: { limit?: number; semantic?: boolean } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 8;
    if (!query.trim()) return [];
    let qv: Float32Array | null = null;
    if (opts.semantic !== false) {
      try {
        qv = (await this.embedder.embed([query]))[0] ?? null;
      } catch {
        qv = null;
      }
    }
    const results: SearchResult[] = [];
    for (const [pageId, p] of this.pages) {
      const keyword = keywordScore(query, p.title, p.text);
      let semantic = 0;
      let best: Chunk | undefined;
      if (qv) {
        let bestCos = -1;
        for (const c of p.chunks) {
          const v = this.vectors.get(c.hash);
          if (!v) continue;
          const cos = cosine(qv, v);
          if (cos > bestCos) {
            bestCos = cos;
            best = c;
          }
        }
        semantic = semanticScale(bestCos);
      }
      const score = qv ? SEMANTIC_WEIGHT * semantic + (1 - SEMANTIC_WEIGHT) * keyword : keyword;
      if (score < 0.1) continue;
      // A result found by meaning alone must be a reasonably close match.
      if (keyword === 0 && semantic < MIN_SEMANTIC_ONLY) continue;
      const terms = tokenize(query);
      const keywordLine = p.chunks.find((c) => c.line >= 0 && terms.some((t) => c.text.toLowerCase().includes(t)));
      const snippetChunk = (keyword > semantic ? keywordLine : undefined) ?? (best && best.line >= 0 ? best : keywordLine);
      results.push({ pageId, title: p.title, score, semantic, keyword, snippet: snippetChunk?.text ?? '' });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Pages most similar in meaning to `pageId`. Pages are compared at the
   * paragraph level: each chunk is matched with its closest chunk on the
   * other page, and those best matches are averaged in both directions.
   * (Averaging whole pages into one vector first blurs topics together.)
   */
  related(pageId: string, opts: { limit?: number; min?: number } = {}): RelatedPage[] {
    const mine = this.chunkVectors(pageId);
    if (mine.length === 0) return [];
    const out: RelatedPage[] = [];
    for (const [id, p] of this.pages) {
      if (id === pageId) continue;
      const theirs = this.chunkVectors(id);
      if (theirs.length === 0) continue;
      const similarity = (meanBestMatch(mine, theirs) + meanBestMatch(theirs, mine)) / 2;
      if (similarity >= (opts.min ?? 0.2)) out.push({ pageId: id, title: p.title, similarity });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.limit ?? 3);
  }

  private chunkVectors(pageId: string): Float32Array[] {
    const p = this.pages.get(pageId);
    if (!p) return [];
    return p.chunks.map((c) => this.vectors.get(c.hash)).filter((v): v is Float32Array => v !== undefined);
  }
}

/**
 * Debounced re-indexing: many edits to a page within `delayMs` cause one
 * update. Updates run one at a time so the embedder isn't flooded.
 */
export class IndexScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each page's pending run was first requested (for the max wait). */
  private readonly firstAt = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param maxWaitMs a page that keeps changing (a collaborator typing
   *   non-stop) is still indexed at least this often: debounce without a
   *   cap would starve it.
   */
  constructor(
    private readonly run: (pageId: string) => Promise<unknown>,
    private readonly delayMs = 1200,
    private readonly maxWaitMs = 3 * delayMs,
  ) {}

  schedule(pageId: string, delayMs = this.delayMs): void {
    const t = this.timers.get(pageId);
    if (t) clearTimeout(t);
    const now = Date.now();
    const first = this.firstAt.get(pageId) ?? now;
    this.firstAt.set(pageId, first);
    const wait = Math.max(0, Math.min(delayMs, first + this.maxWaitMs - now));
    this.timers.set(
      pageId,
      setTimeout(() => {
        this.timers.delete(pageId);
        this.firstAt.delete(pageId);
        this.queue = this.queue.then(() => this.run(pageId)).catch((e: unknown) => console.warn('indexing failed', e));
      }, wait),
    );
  }

  /** Resolves when nothing is scheduled or running. */
  async idle(): Promise<void> {
    while (this.timers.size > 0) await new Promise((r) => setTimeout(r, 20));
    await this.queue;
  }
}

/** Average, over `a`, of each vector's best cosine match in `b`. */
function meanBestMatch(a: Float32Array[], b: Float32Array[]): number {
  let sum = 0;
  for (const x of a) {
    let best = -1;
    for (const y of b) best = Math.max(best, cosine(x, y));
    sum += best;
  }
  return sum / a.length;
}
