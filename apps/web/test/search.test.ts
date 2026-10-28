import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkPage, hashText } from '../src/search/chunk.js';
import { IndexScheduler, keywordScore, normalize, SearchIndex, type Embedder } from '../src/search/index.js';
import { IdbVectorStore } from '../src/search/store.js';

/**
 * Deterministic fake embedder with a tiny "meaning" table: words in the
 * same group map to the same dimension, so "automobile" is close to "car"
 * without sharing a keyword. Counts how many texts it embedded.
 */
class FakeEmbedder implements Embedder {
  readonly model = 'fake-v1';
  calls: string[] = [];
  private static readonly groups = [
    ['car', 'automobile', 'vehicle', 'driving', 'garage'],
    ['holiday', 'vacation', 'trip', 'travel', 'flight', 'lisbon'],
    ['recipe', 'cooking', 'bake', 'bread', 'flour', 'oven'],
    ['budget', 'money', 'savings', 'expenses', 'rent'],
  ];
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        const g = FakeEmbedder.groups.findIndex((ws) => ws.includes(w));
        const dim = g >= 0 ? g : 8 + (hashText(w).charCodeAt(0) % 56);
        v[dim]! += g >= 0 ? 3 : 1;
      }
      return normalize(v);
    });
  }
}

let dbn = 0;
const newStore = () => IdbVectorStore.open(`search-test-${dbn++}`);

describe('chunking', () => {
  it('one chunk per meaningful line, markers stripped, title included', () => {
    const chunks = chunkPage('Trip to Lisbon', '# Before we go\n[ ] book the flat\n\n- shoes\nok\n> remember sunscreen');
    expect(chunks.map((c) => [c.line, c.text])).toEqual([
      [-1, 'Trip to Lisbon'],
      [0, 'Before we go'],
      [1, 'book the flat'],
      [3, 'shoes'],
      [5, 'remember sunscreen'],
    ]);
  });

  it('splits long paragraphs at sentence boundaries', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkPage('', long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 480)).toBe(true);
    expect(chunks.map((c) => c.text).join(' ')).toBe(long);
  });

  it('hashes are content addressed', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hellp'));
  });
});

describe('incremental indexing', () => {
  it('re-embeds only changed lines, reuses moved ones and persisted vectors', async () => {
    const store = await newStore();
    const e = new FakeEmbedder();
    const index = new SearchIndex(e, store);
    const body = 'First paragraph about the car.\nSecond about the budget.\nThird about bread.';
    expect(await index.update('p', 'Notes', body)).toEqual({ embedded: 4, reused: 0 });

    // Edit one line: one new embedding.
    const edited = body.replace('budget', 'monthly budget');
    expect(await index.update('p', 'Notes', edited)).toEqual({ embedded: 1, reused: 3 });
    expect(e.calls.at(-1)).toBe('Second about the monthly budget.');

    // Reorder lines: nothing to embed.
    const moved = edited.split('\n').reverse().join('\n');
    expect((await index.update('p', 'Notes', moved)).embedded).toBe(0);

    // A fresh index (e.g. after reload) finds the vectors in IndexedDB.
    const e2 = new FakeEmbedder();
    const index2 = new SearchIndex(e2, store);
    expect((await index2.update('p', 'Notes', moved)).embedded).toBe(0);
    expect(e2.calls).toEqual([]);
  });

  it('prunes vectors no page uses any more', async () => {
    const store = await newStore();
    const index = new SearchIndex(new FakeEmbedder(), store);
    await index.update('p', 'A title', 'old line one\nold line two');
    await index.update('p', 'A title', 'new line');
    expect(await index.prune()).toBe(2);
  });

  describe('debouncing', () => {
    afterEach(() => vi.useRealTimers());
    it('many quick edits cause one update per page', async () => {
      vi.useFakeTimers();
      const runs: string[] = [];
      const s = new IndexScheduler(async (id) => void runs.push(id), 1000);
      for (let i = 0; i < 20; i++) {
        s.schedule('a');
        await vi.advanceTimersByTimeAsync(100);
      }
      s.schedule('b');
      expect(runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runs.sort()).toEqual(['a', 'b']);
    });

    it('a page that never stops changing is still indexed (max wait)', async () => {
      vi.useFakeTimers();
      const runs: number[] = [];
      const s = new IndexScheduler(async () => void runs.push(Date.now()), 1000, 3000);
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        s.schedule('busy');
        await vi.advanceTimersByTimeAsync(100); // 10 s of continuous edits
      }
      expect(runs.length).toBeGreaterThanOrEqual(3);
      expect(runs[0]! - start).toBeLessThanOrEqual(3000);
    });
  });
});

describe('ranking', () => {
  async function corpus() {
    const index = new SearchIndex(new FakeEmbedder(), await newStore());
    await index.update('car', 'Garage', 'Service the vehicle before winter.\nNew tyres.');
    await index.update('trip', 'Summer plans', 'Flights to Lisbon in June.\nPack light.');
    await index.update('bread', 'Sourdough', 'Feed the starter.\nBake at 240 degrees.');
    await index.update('money', 'Household', 'Rent is due on the first.\nTrack expenses weekly.');
    return index;
  }

  it('finds a page by meaning with no shared keywords', async () => {
    const index = await corpus();
    const [top] = await index.search('automobile');
    expect(top!.pageId).toBe('car');
    expect(top!.keyword).toBe(0);
    expect(top!.semantic).toBeGreaterThan(0.5);
    expect((await index.search('vacation'))[0]!.pageId).toBe('trip');
  });

  it('falls back to keywords when semantic search is unavailable', async () => {
    const index = await corpus();
    expect(await index.search('automobile', { semantic: false })).toEqual([]);
    const [top] = await index.search('tyres', { semantic: false });
    expect(top!.pageId).toBe('car');
    expect(top!.snippet).toBe('New tyres.');
  });

  it('matching both by words and meaning beats either alone', async () => {
    const index = await corpus();
    await index.update('bread2', 'Oven notes', 'Bread needs a hot oven.');
    const results = await index.search('bread oven');
    expect(results[0]!.pageId).toBe('bread2'); // words ("bread", "oven") + meaning
    expect(results.map((r) => r.pageId)).toContain('bread');
    expect(results[0]!.score).toBeGreaterThan(results.find((r) => r.pageId === 'bread')!.score);
  });

  it('keyword score: title beats body, last term matches as a prefix', () => {
    expect(keywordScore('lisbon', 'Lisbon', '')).toBe(1);
    expect(keywordScore('lisbon', 'Trip', 'Lisbon in June')).toBeCloseTo(0.6);
    expect(keywordScore('lis', 'Lisbon', '')).toBe(1);
    expect(keywordScore('lis june', 'Lisbon', '')).toBe(0);
  });

  it('related notes are the closest pages in meaning', async () => {
    const index = await corpus();
    await index.update('trip2', 'Packing for the holiday', 'Travel adapter, sunscreen.');
    const related = index.related('trip');
    expect(related[0]!.pageId).toBe('trip2');
    expect(related.map((r) => r.pageId)).not.toContain('trip');
  });
});
