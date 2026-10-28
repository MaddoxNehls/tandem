/**
 * Embedding worker: runs a small sentence-embedding model on this device
 * with transformers.js (ONNX Runtime Web, WASM). Model weights are
 * downloaded once from the Hugging Face CDN and cached by the browser (Cache
 * Storage); note text never leaves this worker.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

env.allowLocalModels = false;
env.useBrowserCache = true;

type Request = { id: number; texts: string[] } | { id: number; load: true };
export type WorkerMessage =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id?: number; message: string };

const post = (m: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

const files = new Map<string, { loaded: number; total: number }>();
let extractor: Promise<FeatureExtractionPipeline> | null = null;

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        post({ type: 'progress', loaded, total });
      }
    },
  }).then((ex) => {
    post({ type: 'ready' });
    return ex as FeatureExtractionPipeline;
  });
  return extractor;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    const ex = await load();
    if ('load' in req) return;
    const out = await ex(req.texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1]!;
    const data = out.data as Float32Array;
    const vectors = req.texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
    post({ type: 'result', id: req.id, vectors }, vectors.map((v) => v.buffer));
  } catch (err) {
    extractor = null; // allow a retry (e.g. after coming back online)
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
