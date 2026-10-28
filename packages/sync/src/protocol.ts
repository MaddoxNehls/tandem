/**
 * Tandem sync protocol (one WebSocket, many documents).
 *
 * Control messages are JSON text frames. Operations travel as binary frames
 * so they reuse the CRDT package's compact encoding:
 *
 *   binary frame = [0x01] [varint docId byte length] [docId UTF-8] [encodeOps(...)]
 *
 * Handshake, per document:
 *
 *   client                                   server
 *     │ hello {docId, token, agents, version}  │  token checked: edit or view
 *     │ ─────────────────────────────────────▶ │
 *     │          ops the client is missing      │  doc.getOps(client version)
 *     │ ◀───────────────────────────────────── │
 *     │          welcome {cap, version}         │  server's version vector
 *     │ ◀───────────────────────────────────── │
 *     │ ops the server is missing (own agents)  │  only if cap = edit
 *     │ ─────────────────────────────────────▶ │
 *     │          ack {version}                  │  after applying + queueing for Postgres
 *     │ ◀───────────────────────────────────── │
 *     │        live: ops ⇄, presence ⇄          │
 *
 * Presence (cursors, names, colours) is ephemeral: relayed by the server,
 * never stored, and not part of the CRDT.
 */

import type { CursorRef, VersionVector } from '@tandem/crdt';

export type Capability = 'edit' | 'view';

export interface PeerUser {
  name: string;
  color: string;
}

export interface PresenceCursor {
  anchor: CursorRef;
  head: CursorRef;
}

export type ClientMessage =
  | {
      type: 'hello';
      docId: string;
      token: string;
      /** Agent ids this client may send ops for (this session's and older offline ones). */
      agents: string[];
      version: VersionVector;
      user: PeerUser;
    }
  | { type: 'presence'; docId: string; cursor: PresenceCursor | null }
  | { type: 'bye'; docId: string };

export type ServerMessage =
  | { type: 'welcome'; docId: string; cap: Capability; version: VersionVector }
  | { type: 'ack'; docId: string; version: VersionVector }
  | { type: 'presence'; docId: string; peer: string; user: PeerUser; cursor: PresenceCursor | null }
  | { type: 'leave'; docId: string; peer: string }
  | { type: 'error'; docId?: string; code: ErrorCode; message: string };

export type ErrorCode = 'bad-token' | 'read-only' | 'invalid-op' | 'bad-message' | 'not-your-agent' | 'overloaded';

const FRAME_OPS = 0x01;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeOpsFrame(docId: string, ops: Uint8Array): Uint8Array {
  const id = textEncoder.encode(docId);
  const head: number[] = [FRAME_OPS];
  let n = id.length;
  while (n >= 0x80) {
    head.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  head.push(n);
  const out = new Uint8Array(head.length + id.length + ops.length);
  out.set(head, 0);
  out.set(id, head.length);
  out.set(ops, head.length + id.length);
  return out;
}

export function decodeOpsFrame(frame: Uint8Array): { docId: string; ops: Uint8Array } {
  if (frame.length < 2 || frame[0] !== FRAME_OPS) throw new Error('not an ops frame');
  let p = 1;
  let len = 0;
  let shift = 0;
  for (;;) {
    if (p >= frame.length || shift > 21) throw new Error('bad frame header');
    const b = frame[p++]!;
    len |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  if (p + len > frame.length || len > 256) throw new Error('bad frame doc id');
  return { docId: textDecoder.decode(frame.subarray(p, p + len)), ops: frame.subarray(p + len) };
}

/** `ws1234` or `ws1234:page-id`: the workspace doc and its page docs. */
const DOC_ID = /^([A-Za-z0-9_-]{8,64})(?::([A-Za-z0-9_-]{1,64}))?$/;

export function workspaceOf(docId: string): string | null {
  const m = DOC_ID.exec(docId);
  return m ? m[1]! : null;
}

/** True if `a` has everything `b` has. */
export function covers(a: VersionVector, b: VersionVector): boolean {
  for (const [agent, n] of Object.entries(b)) if ((a[agent] ?? 0) < n) return false;
  return true;
}
