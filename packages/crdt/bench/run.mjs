// Benchmark driver: replays the automerge-perf editing trace (Kleppmann's
// LaTeX paper, 259,778 single-character-ish edits) in Tandem, Yjs and
// Automerge. Each library runs in fresh processes (so heap measurements
// don't interfere); timings are the median of RUNS runs.
//
//   pnpm bench               (builds first)
//   node bench/run.mjs [runs]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const TRACE_URL =
  'https://github.com/josephg/editing-traces/raw/master/sequential_traces/automerge-paper.json.gz';
const tracePath = join(here, '.data', 'automerge-paper.json.gz');
const RUNS = Number(process.argv[2] ?? 5);

if (!existsSync(tracePath)) {
  mkdirSync(dirname(tracePath), { recursive: true });
  console.log(`downloading ${TRACE_URL}`);
  const res = await fetch(TRACE_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(tracePath, Buffer.from(await res.arrayBuffer()));
}

// Automerge with one change per edit takes ~50 s per run, so it runs once.
const libs = [
  ['tandem', RUNS],
  ['yjs', RUNS],
  ['automerge-1change', RUNS],
  ['automerge', 1],
];

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const results = {};
for (const [lib, runs] of libs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const out = execFileSync(process.execPath, ['--expose-gc', join(here, 'one.mjs'), lib, tracePath], {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    });
    samples.push(JSON.parse(out.trim().split('\n').pop()));
    process.stdout.write('.');
  }
  const r = { ...samples[0] };
  for (const k of ['applyMs', 'opsPerSec', 'memoryBytes', 'saveMs', 'loadMs']) r[k] = median(samples.map((s) => s[k]));
  if (r.extra?.remoteMs !== undefined) r.extra.remoteMs = median(samples.map((s) => s.extra.remoteMs));
  r.runs = runs;
  results[lib] = r;
}
console.log();

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const kb = (b) => `${fmt(b / 1024, 1)} KB`;
const mb = (b) => `${fmt(b / 1024 / 1024, 1)} MB`;

const names = {
  tandem: 'Tandem (this package)',
  yjs: 'Yjs 13.6',
  'automerge-1change': 'Automerge 3.5, whole trace in 1 change',
  automerge: 'Automerge 3.5, 1 change per edit',
};
const rows = [
  '| Library | Apply trace | Throughput | Memory after GC | Encoded size | Bytes / edit | Save | Load |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
];
for (const [lib, r] of Object.entries(results)) {
  rows.push(
    `| ${names[lib]} | ${fmt(r.applyMs)} ms | ${fmt(r.opsPerSec / 1000)}k edits/s | ${mb(r.memoryBytes)} | ${kb(r.encodedBytes)} | ${fmt(r.encodedBytes / r.edits, 2)} | ${fmt(r.saveMs, 1)} ms | ${fmt(r.loadMs, 1)} ms |`,
  );
}
const t = results.tandem;
const notes = [
  `Machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} threads, ${mb(os.totalmem())} RAM, ${os.platform()} ${os.release()}, Node ${process.version}.`,
  `Trace: automerge-paper, ${fmt(t.edits)} edits -> ${fmt(t.extra.ops)} run-length-merged Tandem ops, ${fmt(t.extra.spans)} spans, B-tree depth ${t.extra.btreeDepth}.`,
  `Tandem remote apply: ${fmt(t.extra.remoteOps)} unmerged ops through applyRemote in ${fmt(t.extra.remoteMs)} ms (${fmt(t.extra.remoteOps / t.extra.remoteMs)}k ops/s).`,
  `One keystroke as a Tandem sync message: ${t.extra.keystrokeBytes} bytes.`,
  `Medians of ${RUNS} runs (Automerge per-edit: 1 run).`,
];
const table = rows.join('\n') + '\n\n' + notes.map((n) => `- ${n}`).join('\n') + '\n';
console.log(table);
writeFileSync(join(here, 'results.md'), table);
writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
