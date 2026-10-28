/** IndexedDB store for embedding vectors, keyed by `<model>:<content hash>`. */
import type { VectorStore } from './index.js';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbVectorStore implements VectorStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'tandem-search', factory: IDBFactory = indexedDB): Promise<IdbVectorStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('vectors');
    return new IdbVectorStore(await req(open));
  }

  async get(keys: string[]): Promise<(Float32Array | undefined)[]> {
    const store = this.db.transaction('vectors', 'readonly').objectStore('vectors');
    return Promise.all(keys.map((k) => req(store.get(k)) as Promise<Float32Array | undefined>));
  }

  async put(entries: [string, Float32Array][]): Promise<void> {
    const tx = this.db.transaction('vectors', 'readwrite');
    for (const [k, v] of entries) tx.objectStore('vectors').put(v, k);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async prune(keep: Set<string>): Promise<number> {
    const tx = this.db.transaction('vectors', 'readwrite');
    const keys = (await req(tx.objectStore('vectors').getAllKeys())) as string[];
    let n = 0;
    for (const k of keys) {
      if (!keep.has(k)) {
        tx.objectStore('vectors').delete(k);
        n++;
      }
    }
    return n;
  }
}
