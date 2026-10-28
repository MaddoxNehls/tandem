/**
 * Splitting a page into embeddable chunks.
 *
 * One chunk per non-trivial line (a paragraph, heading or list item), with
 * its markdown-ish marker stripped; very long lines are split at sentence
 * boundaries so they fit the model's context. The page title is a chunk too.
 *
 * Chunks are content-addressed: the key is a hash of the chunk text. A
 * vector is computed once per distinct text and reused wherever that text
 * appears, so after an edit only the lines that actually changed are
 * re-embedded (and moving a paragraph costs nothing).
 */
import { lineInfo } from '../editor/blocks.js';

export interface Chunk {
  /** Content hash; also the vector cache key (with the model id). */
  hash: string;
  text: string;
  /** Line number in the page body, or -1 for the title. */
  line: number;
}

const MAX_CHUNK = 480;
const MIN_CHUNK = 3;

/** 53-bit FNV-1a style hash (two 32-bit lanes), as a base-36 string. */
export function hashText(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff)).toString(36);
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + sentence.length + 1 > MAX_CHUNK) {
      parts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${sentence}` : sentence;
    while (cur.length > MAX_CHUNK) {
      parts.push(cur.slice(0, MAX_CHUNK));
      cur = cur.slice(MAX_CHUNK);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

export function chunkPage(title: string, body: string): Chunk[] {
  const out: Chunk[] = [];
  const t = title.trim();
  if (t.length >= MIN_CHUNK) out.push({ hash: hashText(t), text: t, line: -1 });
  body.split('\n').forEach((raw, line) => {
    const info = lineInfo(raw);
    const text = raw.slice(info.marker).trim();
    if (text.length < MIN_CHUNK) return;
    for (const part of splitLong(text)) out.push({ hash: hashText(part), text: part, line });
  });
  return out;
}
