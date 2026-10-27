/**
 * Compact binary encoding for op batches and full-document snapshots.
 *
 * Layout (all integers are LEB128 varints unless noted):
 *
 *   magic        2 bytes  "TD"
 *   version      1 byte   (1)
 *   flags        1 byte   bit0 = snapshot, bit1 = content blob is WTF-8
 *   agents       count, then (byteLength, WTF-8 bytes) per agent id
 *   strings      count, then (byteLength, WTF-8 bytes) per string
 *                (map keys, string values, tree node ids)
 *   opCount
 *   ops          see below
 *   content      byteLength, then the UTF-8 (or WTF-8) bytes of every
 *                insert's text concatenated in op order
 *
 * Each op starts with a header byte:
 *
 *   bits 0-1  kind: 0 insert, 1 delete, 2 set, 3 move
 *   bit 2     same agent as the previous op       (else: agent index)
 *   bit 3     seq is that agent's next seq        (else: seq)
 *   bit 4     lamport = previous op's lamport end (else: zigzag delta)
 *   bits 5-7  kind-specific flags
 *
 * Most edits are made by one agent typing, so bits 2-4 are usually set and
 * the id + timestamp cost zero bytes. Kind-specific payloads:
 *
 *   insert  bit5: originLeft = (agent, seq-1), the "continue typing" case
 *           bit6: originLeft = document start
 *           bit7: originRight = document end
 *           [originLeft  agentIndex, zigzag(seq - op.seq)]  if explicit
 *           [originRight agentIndex, zigzag(seq - op.seq)]  if not end
 *           length of the content in UTF-16 code units
 *   delete  bit5: all targets belong to the op's own agent
 *           targetCount, then per target:
 *           [agentIndex], zigzag(seq - ref), len * 2 + rev
 *           where ref starts at op.seq and then is the previous target's
 *           end in unit order (its seq if reversed, else seq + len)
 *   set     keyStringIndex, valueTag, payload
 *           tags: 0 undefined (delete), 1 null, 2 false, 3 true,
 *                 4 integer (zigzag), 5 float64 (8 bytes LE),
 *                 6 string (string index), 7 other JSON (string index)
 *   move    nodeStringIndex, parentStringIndex
 *
 * Text is stored once, in a single blob, so that it stays contiguous (and
 * compresses well if the transport adds gzip). Positions in Tandem are
 * UTF-16 code units, so a span can be split between the two halves of a
 * surrogate pair; plain UTF-8 cannot represent such a lone surrogate. When
 * the blob contains one, it is written as WTF-8 (UTF-8 that also encodes
 * lone surrogates as 3-byte sequences), and flag bit1 is set.
 */

import type { JsonValue } from './map.js';
import type { DeleteRange, Id, Op } from './ops.js';
import { opSpan } from './ops.js';

const MAGIC0 = 0x54; // 'T'
const MAGIC1 = 0x44; // 'D'
const VERSION = 1;
const FLAG_SNAPSHOT = 1;
const FLAG_WTF8 = 2;

const KIND_INS = 0;
const KIND_DEL = 1;
const KIND_SET = 2;
const KIND_MOVE = 3;
const H_SAME_AGENT = 1 << 2;
const H_SEQ_NEXT = 1 << 3;
const H_LAMPORT_NEXT = 1 << 4;
const H_F5 = 1 << 5;
const H_F6 = 1 << 6;
const H_F7 = 1 << 7;

const V_UNDEFINED = 0;
const V_NULL = 1;
const V_FALSE = 2;
const V_TRUE = 3;
const V_INT = 4;
const V_FLOAT = 5;
const V_STRING = 6;
const V_JSON = 7;

export interface EncodeOptions {
  snapshot?: boolean;
}

// -----------------------------------------------------------------------------
// Byte buffers
// -----------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(256);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  /** Unsigned LEB128; supports integers up to 2^53. */
  uint(n: number): void {
    this.ensure(8);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.pos++] = n;
  }

  /** Zigzag-mapped signed integer: 0,-1,1,-2,... -> 0,1,2,3,... */
  int(n: number): void {
    this.uint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  f64(x: number): void {
    this.ensure(8);
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, x, true);
    this.pos += 8;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('unexpected end of data');
    return this.buf[this.pos++]!;
  }

  uint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
      if (mul > 2 ** 56) throw new RangeError('varint too long');
    }
  }

  int(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new RangeError('unexpected end of data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  f64(): number {
    const x = new DataView(this.buf.buffer, this.buf.byteOffset).getFloat64(this.pos, true);
    this.pos += 8;
    return x;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

// A lone high surrogate, or a low surrogate not preceded by a high one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** WTF-8: UTF-8 that also encodes lone surrogates (as 3-byte sequences). */
export function encodeWtf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let p = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      out[p++] = c;
    } else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    } else {
      out[p++] = 0xf0 | (c >> 18);
      out[p++] = 0x80 | ((c >> 12) & 0x3f);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  return out.slice(0, p);
}

export function decodeWtf8(b: Uint8Array): string {
  const units: number[] = [];
  const chunks: string[] = [];
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    let c: number;
    if (x < 0x80) {
      c = x;
      i += 1;
    } else if (x < 0xe0) {
      c = ((x & 0x1f) << 6) | (b[i + 1]! & 0x3f);
      i += 2;
    } else if (x < 0xf0) {
      c = ((x & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f);
      i += 3;
    } else {
      c =
        ((x & 0x07) << 18) |
        ((b[i + 1]! & 0x3f) << 12) |
        ((b[i + 2]! & 0x3f) << 6) |
        (b[i + 3]! & 0x3f);
      i += 4;
    }
    if (c >= 0x10000) {
      c -= 0x10000;
      units.push(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      units.push(c);
    }
    if (units.length >= 8192) {
      chunks.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  chunks.push(String.fromCharCode(...units));
  return chunks.join('');
}

// -----------------------------------------------------------------------------
// Ops
// -----------------------------------------------------------------------------

class Table {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();
  idx(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
}

/** Encode ops (in causal order) as a sync message or snapshot. */
export function encodeOps(ops: readonly Op[], options: EncodeOptions = {}): Uint8Array {
  const agents = new Table();
  const strings = new Table();
  const body = new Writer();
  const content: string[] = [];
  const nextSeq = new Map<number, number>();
  let prevAgent = -1;
  let lamportEnd = 0;

  for (const op of ops) {
    const a = agents.idx(op.agent);
    let header = 0;
    if (a === prevAgent) header |= H_SAME_AGENT;
    if (nextSeq.get(a) === op.seq) header |= H_SEQ_NEXT;
    if (op.lamport === lamportEnd) header |= H_LAMPORT_NEXT;

    // Header flags first, since they precede the fields they describe.
    switch (op.kind) {
      case 'ins': {
        const ol = op.originLeft;
        if (ol === null) header |= H_F6;
        else if (ol.agent === op.agent && ol.seq === op.seq - 1) header |= H_F5;
        if (op.originRight === null) header |= H_F7;
        break;
      }
      case 'del':
        header |= KIND_DEL;
        if (op.targets.every((t) => t.agent === op.agent)) header |= H_F5;
        break;
      case 'set':
        header |= KIND_SET;
        break;
      case 'move':
        header |= KIND_MOVE;
        break;
    }

    body.byte(header);
    if (!(header & H_SAME_AGENT)) body.uint(a);
    if (!(header & H_SEQ_NEXT)) body.uint(op.seq);
    if (!(header & H_LAMPORT_NEXT)) body.int(op.lamport - lamportEnd);

    switch (op.kind) {
      case 'ins':
        if (!(header & (H_F5 | H_F6))) writeId(body, agents, op.originLeft!, op.seq);
        if (op.originRight !== null) writeId(body, agents, op.originRight, op.seq);
        body.uint(op.content.length);
        content.push(op.content);
        break;
      case 'del': {
        const own = (header & H_F5) !== 0;
        body.uint(op.targets.length);
        let ref = op.seq;
        for (const t of op.targets) {
          if (!own) body.uint(agents.idx(t.agent));
          body.int(t.seq - ref);
          body.uint(t.len * 2 + (t.rev ? 1 : 0));
          ref = t.rev ? t.seq : t.seq + t.len;
        }
        break;
      }
      case 'set':
        body.uint(strings.idx(op.key));
        writeValue(body, strings, op.value);
        break;
      case 'move':
        body.uint(strings.idx(op.node));
        body.uint(strings.idx(op.parent));
        break;
    }

    const span = opSpan(op);
    prevAgent = a;
    nextSeq.set(a, op.seq + span);
    lamportEnd = op.lamport + span;
  }

  const text = content.join('');
  const wtf8 = LONE_SURROGATE.test(text);
  const blob = wtf8 ? encodeWtf8(text) : utf8Encoder.encode(text);

  const out = new Writer();
  out.byte(MAGIC0);
  out.byte(MAGIC1);
  out.byte(VERSION);
  out.byte((options.snapshot ? FLAG_SNAPSHOT : 0) | (wtf8 ? FLAG_WTF8 : 0));
  writeStrings(out, agents.list);
  writeStrings(out, strings.list);
  out.uint(ops.length);
  out.bytes(body.finish());
  out.uint(blob.length);
  out.bytes(blob);
  return out.finish();
}

/** Decode the output of `encodeOps`. */
export function decodeOps(bytes: Uint8Array): Op[] {
  const r = new Reader(bytes);
  if (r.byte() !== MAGIC0 || r.byte() !== MAGIC1) throw new Error('not a Tandem op stream');
  const version = r.byte();
  if (version !== VERSION) throw new Error(`unsupported encoding version ${version}`);
  const flags = r.byte();
  const agents = readStrings(r);
  const strings = readStrings(r);
  const count = r.uint();

  const agentAt = (i: number): string => {
    const s = agents[i];
    if (s === undefined) throw new RangeError(`bad agent index ${i}`);
    return s;
  };
  const stringAt = (i: number): string => {
    const s = strings[i];
    if (s === undefined) throw new RangeError(`bad string index ${i}`);
    return s;
  };

  type Pending = { op: Op; contentLen: number };
  const decoded: Pending[] = [];
  const nextSeq = new Map<number, number>();
  let prevAgent = -1;
  let lamportEnd = 0;

  for (let n = 0; n < count; n++) {
    const header = r.byte();
    const a = header & H_SAME_AGENT ? prevAgent : r.uint();
    const agent = agentAt(a);
    const seq = header & H_SEQ_NEXT ? (nextSeq.get(a) ?? 0) : r.uint();
    const lamport = header & H_LAMPORT_NEXT ? lamportEnd : lamportEnd + r.int();
    let op: Op;
    let contentLen = 0;
    let span = 1;

    switch (header & 3) {
      case KIND_INS: {
        let originLeft: Id | null;
        if (header & H_F6) originLeft = null;
        else if (header & H_F5) originLeft = { agent, seq: seq - 1 };
        else originLeft = readId(r, agentAt, seq);
        const originRight = header & H_F7 ? null : readId(r, agentAt, seq);
        contentLen = r.uint();
        span = contentLen;
        op = { kind: 'ins', agent, seq, lamport, originLeft, originRight, content: '' };
        break;
      }
      case KIND_DEL: {
        const own = (header & H_F5) !== 0;
        const nTargets = r.uint();
        const targets: DeleteRange[] = [];
        let ref = seq;
        span = 0;
        for (let k = 0; k < nTargets; k++) {
          const tAgent = own ? agent : agentAt(r.uint());
          const tSeq = ref + r.int();
          const lenRev = r.uint();
          const len = Math.floor(lenRev / 2);
          const rev = lenRev % 2 === 1;
          targets.push(rev ? { agent: tAgent, seq: tSeq, len, rev } : { agent: tAgent, seq: tSeq, len });
          ref = rev ? tSeq : tSeq + len;
          span += len;
        }
        op = { kind: 'del', agent, seq, lamport, targets };
        break;
      }
      case KIND_SET: {
        const key = stringAt(r.uint());
        op = { kind: 'set', agent, seq, lamport, key, value: readValue(r, stringAt) };
        break;
      }
      default: {
        const node = stringAt(r.uint());
        const parent = stringAt(r.uint());
        op = { kind: 'move', agent, seq, lamport, node, parent };
      }
    }

    decoded.push({ op, contentLen });
    prevAgent = a;
    nextSeq.set(a, seq + span);
    lamportEnd = lamport + span;
  }

  const blob = r.bytes(r.uint());
  const text = flags & FLAG_WTF8 ? decodeWtf8(blob) : utf8Decoder.decode(blob);
  let p = 0;
  const ops: Op[] = [];
  for (const { op, contentLen } of decoded) {
    if (op.kind === 'ins') {
      op.content = text.slice(p, p + contentLen);
      if (op.content.length !== contentLen) throw new RangeError('content blob too short');
      p += contentLen;
    }
    ops.push(op);
  }
  if (p !== text.length) throw new RangeError('content blob has trailing data');
  if (!r.done) throw new RangeError('trailing bytes after op stream');
  return ops;
}

/** True if the bytes were produced by `save()` (vs. a sync message). */
export function isSnapshot(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === MAGIC0 && bytes[1] === MAGIC1 && (bytes[3]! & FLAG_SNAPSHOT) !== 0;
}

function writeId(w: Writer, agents: Table, id: Id, seq: number): void {
  w.uint(agents.idx(id.agent));
  w.int(id.seq - seq);
}

function readId(r: Reader, agentAt: (i: number) => string, seq: number): Id {
  const agent = agentAt(r.uint());
  return { agent, seq: seq + r.int() };
}

function writeStrings(w: Writer, list: readonly string[]): void {
  w.uint(list.length);
  for (const s of list) {
    const b = encodeWtf8(s); // ids/keys may contain lone surrogates
    w.uint(b.length);
    w.bytes(b);
  }
}

function readStrings(r: Reader): string[] {
  const n = r.uint();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(decodeWtf8(r.bytes(r.uint())));
  return out;
}

function writeValue(w: Writer, strings: Table, v: JsonValue | undefined): void {
  if (v === undefined) w.byte(V_UNDEFINED);
  else if (v === null) w.byte(V_NULL);
  else if (v === false) w.byte(V_FALSE);
  else if (v === true) w.byte(V_TRUE);
  else if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
      w.byte(V_INT);
      w.int(v);
    } else {
      w.byte(V_FLOAT);
      w.f64(v);
    }
  } else if (typeof v === 'string') {
    w.byte(V_STRING);
    w.uint(strings.idx(v));
  } else {
    w.byte(V_JSON);
    w.uint(strings.idx(JSON.stringify(v)));
  }
}

function readValue(r: Reader, stringAt: (i: number) => string): JsonValue | undefined {
  const tag = r.byte();
  switch (tag) {
    case V_UNDEFINED:
      return undefined;
    case V_NULL:
      return null;
    case V_FALSE:
      return false;
    case V_TRUE:
      return true;
    case V_INT:
      return r.int();
    case V_FLOAT:
      return r.f64();
    case V_STRING:
      return stringAt(r.uint());
    case V_JSON:
      return JSON.parse(stringAt(r.uint())) as JsonValue;
    default:
      throw new RangeError(`bad value tag ${tag}`);
  }
}
