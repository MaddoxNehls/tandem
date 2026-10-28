import 'fake-indexeddb/auto';
import { Doc } from '@tandem/crdt';
import { describe, expect, it } from 'vitest';
import { DocPersister, loadDoc, LocalStore } from '../src/lib/storage.js';

let n = 0;
const freshStore = () => LocalStore.open(`test-${n++}`);

describe('IndexedDB persistence', () => {
  it('reloads a document from appended op batches', async () => {
    const store = await freshStore();
    const doc = new Doc({ agent: 'tab-1' });
    const p = new DocPersister(store, 'ws:page', doc);
    doc.insert(0, 'hello');
    doc.insert(5, ' world');
    doc.setMeta('title', 'Greeting');
    await p.flush();
    doc.delete(0, 6);
    await p.dispose();

    const { doc: reloaded } = await loadDoc(store, 'ws:page', 'tab-2');
    expect(reloaded.text).toBe('world');
    expect(reloaded.getMeta('title')).toBe('Greeting');
    expect(reloaded.agent).toBe('tab-2');
    // Other docs are unaffected.
    expect((await loadDoc(store, 'ws:other', 'tab-2')).doc.text).toBe('');
  });

  it('persists remote ops too, and compacts into a snapshot', async () => {
    const store = await freshStore();
    const doc = new Doc({ agent: 'me' });
    const p = new DocPersister(store, 'd', doc);
    const remote = new Doc({ agent: 'them' });
    for (let i = 0; i < 120; i++) {
      remote.insert(remote.length, `${i} `);
      doc.applyRemote(remote.getOps(doc.version()));
      doc.insert(0, '.');
      await p.flush(); // one row per round: crosses the snapshot threshold
    }
    await p.dispose();
    const stored = await store.load('d');
    expect(stored.snapshot).not.toBeNull();
    expect(stored.batches.length).toBeLessThan(100);
    const { doc: reloaded } = await loadDoc(store, 'd', 'me-again');
    expect(reloaded.text).toBe(doc.text);
    expect(reloaded.visibleIds()).toEqual(doc.visibleIds());
  });
});
