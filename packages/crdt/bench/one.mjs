// Runs one benchmark (one library) in a fresh process and prints JSON.
// Usage: node --expose-gc bench/one.mjs <tandem|yjs|automerge|automerge-1change> <trace.json.gz>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

const [lib, tracePath] = process.argv.slice(2);
const trace = JSON.parse(gunzipSync(readFileSync(tracePath)).toString('utf8'));
const patches = trace.txns.flatMap((t) => t.patches);

function gc() {
  for (let i = 0; i < 3; i++) globalThis.gc();
}
function mem() {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

const adapters = {
  async tandem() {
    const { Doc, encodeOps } = await import('../dist/index.js');
    return {
      create: () => new Doc({ agent: 'author' }),
      apply(doc, [pos, del, ins]) {
        if (del > 0) doc.delete(pos, del);
        if (ins.length > 0) doc.insert(pos, ins);
        return doc;
      },
      text: (doc) => doc.text,
      save: (doc) => doc.save(),
      load: (bytes) => Doc.load(bytes, { agent: 'reader' }),
      extra(doc) {
        // Remote-apply throughput: replay every edit's individual (unmerged)
        // op on a fresh replica through applyRemote.
        const src = new Doc({ agent: 'author' });
        const ops = [];
        src.on('change', (e) => ops.push(...e.ops));
        for (const [pos, del, ins] of patches) {
          if (del > 0) src.delete(pos, del);
          if (ins.length > 0) src.insert(pos, ins);
        }
        const dst = new Doc({ agent: 'peer' });
        const t = performance.now();
        for (const op of ops) dst.applyRemote([op]);
        const remoteMs = performance.now() - t;
        if (dst.text !== trace.endContent) throw new Error('remote replay diverged');

        // Size of one keystroke as a sync message.
        const peer = Doc.load(doc.save(), { agent: 'peer2' });
        const v = peer.version();
        peer.insert(peer.length >> 1, 'x');
        const keystrokeBytes = encodeOps(peer.getOps(v)).length;
        return { ...doc.stats(), remoteOps: ops.length, remoteMs, keystrokeBytes };
      },
    };
  },
  async yjs() {
    const Y = await import('yjs');
    return {
      create: () => new Y.Doc(),
      apply(doc, [pos, del, ins]) {
        const t = doc.getText('text');
        if (del > 0) t.delete(pos, del);
        if (ins.length > 0) t.insert(pos, ins);
        return doc;
      },
      text: (doc) => doc.getText('text').toString(),
      save: (doc) => Y.encodeStateAsUpdate(doc),
      load(bytes) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        return doc;
      },
      extra: () => ({}),
    };
  },
  async automerge() {
    const A = await import('@automerge/automerge');
    return {
      create: () => A.from({ text: '' }),
      // One Automerge change per edit, like the other two libraries.
      apply: (doc, [pos, del, ins]) => A.change(doc, (d) => A.splice(d, ['text'], pos, del, ins)),
      text: (doc) => doc.text,
      save: (doc) => A.save(doc),
      load: (bytes) => A.load(bytes),
      extra: () => ({}),
    };
  },
  // Automerge with the whole trace inside a single change: far fewer change
  // records (and hashes), but no intermediate versions to sync or undo to.
  async 'automerge-1change'() {
    const A = await import('@automerge/automerge');
    return {
      create: () => A.from({ text: '' }),
      applyAll: (doc, ps) =>
        A.change(doc, (d) => {
          for (const [pos, del, ins] of ps) A.splice(d, ['text'], pos, del, ins);
        }),
      text: (doc) => doc.text,
      save: (doc) => A.save(doc),
      load: (bytes) => A.load(bytes),
      extra: () => ({}),
    };
  },
};

const a = await adapters[lib]();
gc();
const memBefore = mem();

let doc = a.create();
const t0 = performance.now();
if (a.applyAll) doc = a.applyAll(doc, patches);
else for (const p of patches) doc = a.apply(doc, p);
const applyMs = performance.now() - t0;
if (a.text(doc) !== trace.endContent) throw new Error(`${lib}: final text does not match the trace`);

gc();
const memoryBytes = mem() - memBefore;

const t1 = performance.now();
const bytes = a.save(doc);
const saveMs = performance.now() - t1;

const t2 = performance.now();
const loaded = a.load(bytes);
const loadedText = a.text(loaded);
const loadMs = performance.now() - t2;
if (loadedText !== trace.endContent) throw new Error(`${lib}: loaded text does not match the trace`);

console.log(
  JSON.stringify({
    lib,
    edits: patches.length,
    applyMs,
    opsPerSec: patches.length / (applyMs / 1000),
    memoryBytes,
    encodedBytes: bytes.length,
    saveMs,
    loadMs,
    extra: a.extra(doc),
  }),
);
