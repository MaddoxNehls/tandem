/**
 * Tandem sync server: a WebSocket relay that also holds an authoritative
 * replica of every open document.
 *
 * Per document ("room") the server keeps a `Doc` loaded from Postgres. Ops
 * from clients are decoded, validated (structure via `validateOp`, existence
 * of referenced ids via `applyRemote`, ownership of agent ids, edit
 * capability), applied, broadcast to the other subscribers, and appended to
 * Postgres in batches. A client's ops are acknowledged only once the batch
 * containing them is durable, so 'synced' in the UI means "safe on the
 * server".
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { decodeOps, Doc, encodeOps, InvalidOpError, type Op, type VersionVector } from '@tandem/crdt';
import {
  decodeOpsFrame,
  encodeOpsFrame,
  workspaceOf,
  type Capability,
  type ClientMessage,
  type ErrorCode,
  type PeerUser,
  type PresenceCursor,
  type ServerMessage,
} from '@tandem/sync';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Store } from './store.js';
import { mintToken, verifyToken } from './tokens.js';

export interface SyncServerOptions {
  store: Store;
  secret: string;
  port?: number;
  host?: string;
  /** Serve a built web app from this directory (production / one-command mode). */
  staticDir?: string;
  /** Batch window for Postgres appends. */
  flushMs?: number;
  /** Rewrite the snapshot on load when more op rows than this follow it. */
  snapshotThreshold?: number;
  log?: (msg: string) => void;
}

export interface SyncServer {
  port: number;
  url: string;
  close(): Promise<void>;
  /** Test hook: the server's replica of a doc, if loaded. */
  peekDoc(docId: string): Doc | undefined;
}

const MAX_PENDING = 10_000;
const MAX_AGENTS = 256;
const ROOM_IDLE_MS = 30_000;

interface Subscriber {
  peer: string;
  user: PeerUser;
  cap: Capability;
  agents: Set<string>;
  cursor: PresenceCursor | null;
  lastPresence: number;
}

class Room {
  readonly subs = new Map<Conn, Subscriber>();
  private queue: Op[] = [];
  private waiters: (() => void)[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly docId: string,
    readonly doc: Doc,
    private readonly store: Store,
    private readonly flushMs: number,
  ) {}

  /** Queue ops for Postgres; resolves when they are durable. */
  persist(ops: Op[]): Promise<void> {
    this.queue.push(...ops);
    const done = new Promise<void>((res) => this.waiters.push(res));
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs);
    return done;
  }

  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ops = this.queue;
    const waiters = this.waiters;
    this.queue = [];
    this.waiters = [];
    if (ops.length === 0) {
      for (const w of waiters) w();
      return this.flushing;
    }
    this.flushing = this.flushing
      .then(() => this.store.appendOps(this.docId, encodeOps(ops)))
      .then(() => {
        for (const w of waiters) w();
      });
    return this.flushing;
  }
}

class Conn {
  readonly peer = Math.random().toString(36).slice(2, 10);
  readonly docs = new Set<string>();
  /** Messages are handled strictly in order, even across async loads. */
  chain: Promise<void> = Promise.resolve();
  constructor(readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendOps(docId: string, ops: Op[]): void {
    if (ops.length > 0 && this.ws.readyState === this.ws.OPEN) this.ws.send(encodeOpsFrame(docId, encodeOps(ops)));
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fatal: boolean,
    readonly docId?: string,
  ) {
    super(message);
  }
}

export async function startSyncServer(opts: SyncServerOptions): Promise<SyncServer> {
  const log = opts.log ?? (() => {});
  const flushMs = opts.flushMs ?? 25;
  const snapshotThreshold = opts.snapshotThreshold ?? 200;
  const rooms = new Map<string, Promise<Room>>();
  const loaded = new Map<string, Room>();

  async function loadRoom(docId: string): Promise<Room> {
    const data = await opts.store.loadDoc(docId);
    const doc = data.snapshot ? Doc.load(data.snapshot, { agent: 'server' }) : new Doc({ agent: 'server' });
    for (const row of data.rows) doc.applyRemote(decodeOps(row.ops));
    // Snapshot on load: fold a long tail of op rows into a fresh snapshot.
    if (data.rows.length > snapshotThreshold) {
      await opts.store.compact(docId, doc.save(), data.rows[data.rows.length - 1]!.id);
      log(`compacted ${docId}: ${data.rows.length} op rows -> snapshot`);
    }
    const room = new Room(docId, doc, opts.store, flushMs);
    loaded.set(docId, room);
    return room;
  }

  function room(docId: string): Promise<Room> {
    let r = rooms.get(docId);
    if (!r) {
      r = loadRoom(docId);
      rooms.set(docId, r);
      r.catch(() => rooms.delete(docId));
    }
    return r;
  }

  function leave(conn: Conn, docId: string): void {
    const r = loaded.get(docId);
    if (!r || !r.subs.delete(conn)) return;
    conn.docs.delete(docId);
    for (const other of r.subs.keys()) other.send({ type: 'leave', docId, peer: conn.peer });
    if (r.subs.size === 0) {
      r.idleTimer = setTimeout(() => {
        if (r.subs.size > 0) return;
        void r.flush().then(() => {
          if (r.subs.size === 0) {
            rooms.delete(docId);
            loaded.delete(docId);
          }
        });
      }, ROOM_IDLE_MS);
    }
  }

  async function onHello(conn: Conn, msg: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    const docId = msg.docId;
    const ws = typeof docId === 'string' ? workspaceOf(docId) : null;
    if (!ws) throw new ProtocolError('bad-message', 'bad docId', true);
    const cap = verifyToken(opts.secret, ws, msg.token);
    if (!cap) throw new ProtocolError('bad-token', 'invalid or missing token', false, docId);
    if (!Array.isArray(msg.agents) || msg.agents.length > MAX_AGENTS || !msg.agents.every((a) => typeof a === 'string')) {
      throw new ProtocolError('bad-message', 'bad agents', true, docId);
    }
    const user = sanitizeUser(msg.user);
    const version = sanitizeVersion(msg.version);

    const r = await room(docId);
    if (conn.ws.readyState !== conn.ws.OPEN) return; // closed while loading
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.subs.set(conn, { peer: conn.peer, user, cap, agents: new Set(msg.agents), cursor: null, lastPresence: 0 });
    conn.docs.add(docId);

    conn.sendOps(docId, r.doc.getOps(version));
    conn.send({ type: 'welcome', docId, cap, version: r.doc.version() });
    for (const [other, sub] of r.subs) {
      if (other !== conn && sub.cursor) conn.send({ type: 'presence', docId, peer: sub.peer, user: sub.user, cursor: sub.cursor });
    }
  }

  async function onOps(conn: Conn, frame: Uint8Array): Promise<void> {
    let docId: string;
    let bytes: Uint8Array;
    try {
      ({ docId, ops: bytes } = decodeOpsFrame(frame));
    } catch {
      throw new ProtocolError('bad-message', 'bad ops frame', true);
    }
    const r = loaded.get(docId);
    const sub = r?.subs.get(conn);
    if (!r || !sub) throw new ProtocolError('bad-message', 'ops for a doc you have not joined', true, docId);
    if (sub.cap !== 'edit') throw new ProtocolError('read-only', 'this share link is view-only', false, docId);

    let ops: Op[];
    try {
      ops = decodeOps(bytes);
    } catch (err) {
      throw new ProtocolError('invalid-op', `undecodable ops: ${String(err)}`, true, docId);
    }
    for (const op of ops) {
      if (!sub.agents.has(op.agent)) {
        throw new ProtocolError('not-your-agent', `ops for agent ${op.agent} not declared in hello`, true, docId);
      }
    }

    const before = r.doc.version();
    let failure: ProtocolError | null = null;
    try {
      r.doc.applyRemote(ops);
    } catch (err) {
      if (!(err instanceof InvalidOpError)) throw err;
      failure = new ProtocolError('invalid-op', err.message, true, docId);
    }
    if (r.doc.pending > MAX_PENDING) failure ??= new ProtocolError('overloaded', 'too many ops with missing dependencies', true, docId);

    // Whatever was applied (possibly including previously buffered ops) is
    // broadcast and persisted, even if a later op in the batch was invalid.
    const applied = r.doc.getOps(before);
    if (applied.length > 0) {
      for (const other of r.subs.keys()) if (other !== conn) other.sendOps(docId, applied);
    }
    const version = r.doc.version();
    void r.persist(applied).then(() => conn.send({ type: 'ack', docId, version }));
    if (failure) throw failure;
  }

  function onPresence(conn: Conn, msg: Extract<ClientMessage, { type: 'presence' }>): void {
    const r = loaded.get(msg.docId);
    const sub = r?.subs.get(conn);
    if (!r || !sub) return;
    const now = Date.now();
    if (now - sub.lastPresence < 20) return; // clients throttle; this is a backstop
    sub.lastPresence = now;
    sub.cursor = sanitizeCursor(msg.cursor);
    for (const other of r.subs.keys()) {
      if (other !== conn) other.send({ type: 'presence', docId: msg.docId, peer: conn.peer, user: sub.user, cursor: sub.cursor });
    }
  }

  async function handle(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return onOps(conn, toBytes(data));
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      throw new ProtocolError('bad-message', 'invalid JSON', true);
    }
    switch (msg?.type) {
      case 'hello':
        return onHello(conn, msg);
      case 'presence':
        return onPresence(conn, msg);
      case 'bye':
        return leave(conn, msg.docId);
      default:
        throw new ProtocolError('bad-message', 'unknown message type', true);
    }
  }

  const http = createServer((req, res) => {
    void handleHttp(req, res).catch((err) => {
      log(`http error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const claim = /^\/api\/workspaces\/([A-Za-z0-9_-]{8,64})\/claim$/.exec(url.pathname);
    if (claim && req.method === 'POST') {
      const id = claim[1]!;
      if (!(await opts.store.claimWorkspace(id))) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'already claimed' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ editToken: mintToken(opts.secret, id, 'edit'), viewToken: mintToken(opts.secret, id, 'view') }),
      );
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (opts.staticDir && req.method === 'GET') return serveStatic(opts.staticDir, url.pathname, res);
    res.writeHead(404).end();
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/sync') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn = new Conn(ws);
    ws.on('message', (data, isBinary) => {
      conn.chain = conn.chain
        .then(() => handle(conn, data, isBinary))
        .catch((err: unknown) => {
          if (err instanceof ProtocolError) {
            conn.send({ type: 'error', code: err.code, message: err.message, ...(err.docId ? { docId: err.docId } : {}) });
            if (err.fatal) ws.close(1008, err.code);
          } else {
            log(`internal error: ${String(err)}`);
            ws.close(1011, 'internal error');
          }
        });
    });
    ws.on('close', () => {
      for (const docId of [...conn.docs]) leave(conn, docId);
    });
  });

  await new Promise<void>((res) => http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', res));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    url: `ws://${opts.host ?? '127.0.0.1'}:${port}/sync`,
    peekDoc: (docId) => loaded.get(docId)?.doc,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((res) => http.close(() => res()));
      await Promise.all([...loaded.values()].map((r) => r.flush()));
      for (const r of loaded.values()) if (r.idleTimer) clearTimeout(r.idleTimer);
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function sanitizeUser(u: unknown): PeerUser {
  const o = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.slice(0, 40) : 'Anonymous';
  const color = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : '#888888';
  return { name, color };
}

function sanitizeVersion(v: unknown): VersionVector {
  const out: VersionVector = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[k] = n;
  }
  return out;
}

function sanitizeRef(r: unknown): PresenceCursor['anchor'] | undefined {
  if (r === null) return null;
  if (typeof r !== 'object') return undefined;
  const { agent, seq } = r as Record<string, unknown>;
  if (typeof agent !== 'string' || agent.length > 64 || typeof seq !== 'number' || !Number.isSafeInteger(seq)) return undefined;
  return { agent, seq };
}

function sanitizeCursor(c: unknown): PresenceCursor | null {
  if (typeof c !== 'object' || c === null) return null;
  const { anchor, head } = c as Record<string, unknown>;
  const a = sanitizeRef(anchor);
  const h = sanitizeRef(head);
  return a === undefined || h === undefined ? null : { anchor: a, head: h };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(dir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(dir);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const immutable = file.includes(`${join(root, 'assets')}`);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}
