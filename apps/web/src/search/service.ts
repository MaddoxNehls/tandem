/**
 * Glue between the workspace and the search index: a worker-backed
 * embedder, debounced re-indexing of pages as they change (locally or from
 * collaborators), and model status for the UI.
 */
import type { Workspace } from '../lib/workspace.js';
import type { WorkerMessage } from './embed.worker.js';
import { IndexScheduler, SearchIndex, type Embedder, type RelatedPage, type SearchResult } from './index.js';
import { IdbVectorStore } from './store.js';

export type ModelState = 'off' | 'idle' | 'loading' | 'ready' | 'error';

export interface ModelStatus {
  state: ModelState;
  /** 0..1 while downloading. */
  progress: number;
  error?: string;
}

/** Approximate download size of the quantized model, for the UI. */
export const MODEL_SIZE_MB = 23;

class WorkerEmbedder implements Embedder {
  readonly model = 'minilm-l6-v2-q8';
  status: ModelStatus = { state: 'idle', progress: 0 };
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  constructor(private readonly onStatus: () => void) {}

  load(): void {
    if (this.worker) return;
    this.worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'progress') this.setStatus({ state: 'loading', progress: m.total ? m.loaded / m.total : 0 });
      else if (m.type === 'ready') this.setStatus({ state: 'ready', progress: 1 });
      else if (m.type === 'result') {
        this.pending.get(m.id)?.resolve(m.vectors);
        this.pending.delete(m.id);
      } else {
        if (m.id !== undefined) {
          this.pending.get(m.id)?.reject(new Error(m.message));
          this.pending.delete(m.id);
        }
        if (this.status.state !== 'ready') this.setStatus({ state: 'error', progress: 0, error: m.message });
      }
    };
    this.setStatus({ state: 'loading', progress: 0 });
    this.worker.postMessage({ id: 0, load: true });
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    if (this.status.state !== 'ready') return Promise.reject(new Error('model not ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, texts });
    });
  }

  private setStatus(s: ModelStatus): void {
    this.status = s;
    this.onStatus();
  }
}

export class SearchService {
  readonly embedder: WorkerEmbedder;
  private index: SearchIndex | null = null;
  private scheduler: IndexScheduler | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly ws: Workspace) {
    this.embedder = new WorkerEmbedder(() => this.onModelStatus());
  }

  /** Index every page now (keywords immediately; vectors once the model is ready). */
  async start(options: { loadModel: boolean }): Promise<void> {
    this.index = new SearchIndex(this.embedder, await IdbVectorStore.open());
    this.scheduler = new IndexScheduler((pageId) => this.indexPage(pageId));
    for (const pageId of this.livePages()) await this.indexPage(pageId);
    this.ws.onDocChange((pageId) => {
      if (pageId) this.scheduler!.schedule(pageId);
      else for (const id of this.livePages()) if (this.titleChanged(id)) this.scheduler!.schedule(id, 300);
    });
    if (options.loadModel) this.embedder.load();
    else this.embedder.status = { state: 'off', progress: 0 };
    this.bump();
  }

  loadModel(): void {
    this.embedder.load();
  }

  get modelStatus(): ModelStatus {
    return this.embedder.status;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.index) return [];
    const results = await this.index.search(query, { semantic: this.embedder.status.state === 'ready', limit: 8 });
    return results.filter((r) => this.ws.isLive(r.pageId)).map((r) => ({ ...r, title: this.ws.title(r.pageId) }));
  }

  related(pageId: string): RelatedPage[] {
    if (!this.index) return [];
    return this.index
      .related(pageId)
      .filter((r) => this.ws.isLive(r.pageId))
      .map((r) => ({ ...r, title: this.ws.title(r.pageId) }));
  }

  private indexedTitles = new Map<string, string>();

  private titleChanged(pageId: string): boolean {
    return this.indexedTitles.get(pageId) !== this.ws.title(pageId);
  }

  private livePages(): string[] {
    return this.ws.root
      .pages()
      .map(([id]) => id)
      .filter((id) => this.ws.isLive(id) && this.ws.page(id));
  }

  private async indexPage(pageId: string): Promise<void> {
    const doc = this.ws.page(pageId);
    if (!doc || !this.index) return;
    if (!this.ws.isLive(pageId)) {
      this.index.remove(pageId);
      return;
    }
    const title = this.ws.title(pageId);
    this.indexedTitles.set(pageId, title);
    try {
      await this.index.update(pageId, title, doc.text);
    } catch {
      /* model not ready: the page is still searchable by keywords */
    }
    this.bump();
  }

  private onModelStatus(): void {
    if (this.embedder.status.state === 'ready') {
      // Embed everything that was indexed by keywords only, then tidy up.
      void (async () => {
        for (const id of this.livePages()) await this.indexPage(id);
        await this.index?.prune();
      })();
    }
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
