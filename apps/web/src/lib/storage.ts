/**
 * IndexedDB persistence for documents: an append-only op log plus periodic
 * snapshots, mirroring the server's Postgres layout.
 *
 *   ops        { key (auto), doc, bytes }    one row per flushed batch (encodeOps)
 *   snapshots  { doc, bytes, upto }          doc.save() covering ops rows <= upto
 *
 * Loading = snapshot + the rows after it, so reload is instant and works
 * offline. Every SNAPSHOT_EVERY appended rows a fresh snapshot replaces the
 * covered rows, which bounds load time.
 */
import { decodeOps, Doc, encodeOps, type Op } from '@tandem/crdt';

const DB_NAME = 'tandem';
const SNAPSHOT_EVERY = 100;
const FLUSH_MS = 150;

export interface StoredDoc {
  snapshot: Uint8Array | null;
  batches: { key: number; bytes: Uint8Array }[];
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class LocalStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME, factory: IDBFactory = indexedDB): Promise<LocalStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      const ops = db.createObjectStore('ops', { autoIncrement: true });
      ops.createIndex('doc', 'doc');
      db.createObjectStore('snapshots', { keyPath: 'doc' });
    };
    return new LocalStore(await req(open));
  }

  async load(docId: string): Promise<StoredDoc> {
    const tx = this.db.transaction(['ops', 'snapshots'], 'readonly');
    const snap = (await req(tx.objectStore('snapshots').get(docId))) as
      | { bytes: Uint8Array; upto: number }
      | undefined;
    const upto = snap?.upto ?? 0;
    const batches: StoredDoc['batches'] = [];
    const index = tx.objectStore('ops').index('doc');
    await new Promise<void>((resolve, reject) => {
      const cursor = index.openCursor(IDBKeyRange.only(docId));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        const key = c.primaryKey as number;
        if (key > upto) batches.push({ key, bytes: (c.value as { bytes: Uint8Array }).bytes });
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    batches.sort((a, b) => a.key - b.key);
    return { snapshot: snap?.bytes ?? null, batches };
  }

  async append(docId: string, bytes: Uint8Array): Promise<number> {
    const tx = this.db.transaction('ops', 'readwrite');
    const key = (await req(tx.objectStore('ops').add({ doc: docId, bytes }))) as number;
    await done(tx);
    return key;
  }

  /** Store a snapshot covering rows <= upto and delete those rows. */
  async snapshot(docId: string, bytes: Uint8Array, upto: number): Promise<void> {
    const tx = this.db.transaction(['ops', 'snapshots'], 'readwrite');
    tx.objectStore('snapshots').put({ doc: docId, bytes, upto });
    const index = tx.objectStore('ops').index('doc');
    const cursor = index.openCursor(IDBKeyRange.only(docId));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if ((c.primaryKey as number) <= upto) c.delete();
      c.continue();
    };
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

/** Load a doc from local storage (or create an empty one). */
export async function loadDoc(store: LocalStore, docId: string, agent: string): Promise<{ doc: Doc; rows: number }> {
  const stored = await store.load(docId);
  const doc = stored.snapshot ? Doc.load(stored.snapshot, { agent }) : new Doc({ agent });
  for (const b of stored.batches) doc.applyRemote(decodeOps(b.bytes));
  return { doc, rows: stored.batches.length };
}

/**
 * Persists every op a doc applies (local or remote). Ops are buffered for
 * FLUSH_MS and written as one row; `flush()` forces a write (on pagehide).
 */
export class DocPersister {
  private queue: Op[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private rowsSinceSnapshot: number;
  private readonly off: () => void;

  constructor(
    private readonly store: LocalStore,
    private readonly docId: string,
    private readonly doc: Doc,
    existingRows = 0,
  ) {
    this.rowsSinceSnapshot = existingRows;
    this.off = doc.on('change', (e) => {
      this.queue.push(...e.ops);
      this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    });
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return this.writing;
    const bytes = encodeOps(this.queue);
    this.queue = [];
    this.writing = this.writing.then(async () => {
      const key = await this.store.append(this.docId, bytes);
      if (++this.rowsSinceSnapshot >= SNAPSHOT_EVERY) {
        this.rowsSinceSnapshot = 0;
        await this.store.snapshot(this.docId, this.doc.save(), key);
      }
    });
    return this.writing;
  }

  dispose(): Promise<void> {
    this.off();
    return this.flush();
  }
}
