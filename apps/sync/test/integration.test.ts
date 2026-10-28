/**
 * End-to-end sync over real WebSockets and real Postgres: a server, several
 * SyncClients (the same client the web app uses), random concurrent edits,
 * a client that goes offline and reconnects, and capability enforcement.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc, encodeOps } from '@tandem/crdt';
import { covers, encodeOpsFrame, SyncClient, type ServerMessage } from '@tandem/sync';
import { startSyncServer, type SyncServer } from '../src/server.js';
import { PgStore } from '../src/store.js';
import { TEST_DB_URL } from './env.js';

const SECRET = 'integration-test-secret';

let store: PgStore;
let server: SyncServer;
let httpBase: string;

beforeAll(async () => {
  store = await PgStore.connect(TEST_DB_URL);
  server = await startSyncServer({ store, secret: SECRET, port: 0, flushMs: 10 });
  httpBase = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  await store.close();
});

async function newWorkspace(): Promise<{ id: string; editToken: string; viewToken: string }> {
  const id = `it${randomBytes(8).toString('hex')}`;
  const res = await fetch(`${httpBase}/api/workspaces/${id}/claim`, { method: 'POST' });
  expect(res.status).toBe(200);
  const again = await fetch(`${httpBase}/api/workspaces/${id}/claim`, { method: 'POST' });
  expect(again.status).toBe(409); // a workspace can only be claimed once
  return { id, ...((await res.json()) as { editToken: string; viewToken: string }) };
}

interface Peer {
  name: string;
  doc: Doc;
  client: SyncClient;
}

function peer(name: string, docId: string, token: string, url = server.url): Peer {
  const agent = `${name}-${randomBytes(4).toString('hex')}`;
  const doc = new Doc({ agent });
  const client = new SyncClient({ url, token, user: { name, color: '#3366aa' }, agents: () => [agent] });
  client.attach(docId, doc);
  client.connect();
  return { name, doc, client };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function eventually(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await tick(20);
  }
}

/** Open a raw socket and join a doc, returning received messages. */
async function rawJoin(docId: string, token: string, agent: string) {
  const ws = new WebSocket(server.url);
  ws.binaryType = 'arraybuffer';
  const messages: ServerMessage[] = [];
  let closed = false;
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') messages.push(JSON.parse(e.data) as ServerMessage);
  };
  ws.onclose = () => {
    closed = true;
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: 'hello', docId, token, agents: [agent], version: {}, user: { name: 'raw', color: '#000000' } }));
  await eventually(() => messages.some((m) => m.type === 'welcome' || m.type === 'error'), 'welcome');
  return { ws, messages, isClosed: () => closed };
}

describe('sync server', () => {
  it('3 clients converge under random concurrent edits, with one going offline and reconnecting', async () => {
    const ws = await newWorkspace();
    const docId = `${ws.id}:notes`;
    const peers = ['ada', 'bo', 'cy'].map((n) => peer(n, docId, ws.editToken));
    await Promise.all(peers.map((p) => p.client.whenSynced()));

    const rand = rng(1234);
    const words = ['local', 'first ', 'crdt', ' fugue', '\n', 'sync', ' 🙂', 'ok'];
    const edit = (p: Peer) => {
      const len = p.doc.length;
      if (len > 0 && rand() < 0.3) {
        const pos = Math.floor(rand() * len);
        p.doc.delete(pos, Math.min(len - pos, 1 + Math.floor(rand() * 4)));
      } else {
        p.doc.insert(Math.floor(rand() * (len + 1)), words[Math.floor(rand() * words.length)]!);
      }
    };

    for (let i = 0; i < 150; i++) {
      edit(peers[Math.floor(rand() * 3)]!);
      if (i % 10 === 0) await tick(Math.floor(rand() * 5));
    }

    // cy goes offline and keeps editing; the others keep editing too.
    const cy = peers[2]!;
    cy.client.disconnect();
    expect(cy.client.status).toBe('offline');
    for (let i = 0; i < 100; i++) {
      edit(peers[Math.floor(rand() * 3)]!);
      if (i % 10 === 0) await tick(2);
    }
    const offlineText = cy.doc.text;
    await tick(50);
    expect(cy.doc.text).toBe(offlineText); // nothing arrives while offline

    cy.client.connect();
    await Promise.all(peers.map((p) => p.client.whenSynced()));
    const serverDoc = server.peekDoc(docId)!;
    await eventually(
      () => peers.every((p) => covers(p.doc.version(), serverDoc.version()) && covers(serverDoc.version(), p.doc.version())),
      'all replicas to reach the server version',
    );

    const text = serverDoc.text;
    expect(text.length).toBeGreaterThan(0);
    for (const p of peers) {
      expect(p.doc.text).toBe(text);
      expect(p.doc.visibleIds()).toEqual(serverDoc.visibleIds());
    }

    // A brand-new client catches up from nothing.
    const late = peer('late', docId, ws.editToken);
    await eventually(() => late.doc.text === text, 'late joiner catch-up');

    // Everything acked is durable: a second server on the same database
    // loads the same document from Postgres.
    for (const p of [...peers, late]) p.client.disconnect();
    const store2 = await PgStore.connect(TEST_DB_URL);
    const server2 = await startSyncServer({ store: store2, secret: SECRET, port: 0 });
    try {
      const fresh = peer('fresh', docId, ws.editToken, server2.url);
      await eventually(() => fresh.doc.text === text, 'reload from Postgres');
      fresh.client.disconnect();
    } finally {
      await server2.close();
      await store2.close();
    }
  });

  it('enforces view-only tokens on the server', async () => {
    const ws = await newWorkspace();
    const docId = ws.id;
    const writer = peer('writer', docId, ws.editToken);
    writer.doc.insert(0, 'original');
    await writer.client.whenSynced();

    const viewer = await rawJoin(docId, ws.viewToken, 'viewer-agent');
    expect(viewer.messages.find((m) => m.type === 'welcome')).toMatchObject({ cap: 'view' });

    // Forge a perfectly valid op and send it with a view token.
    const forged = new Doc({ agent: 'viewer-agent' });
    forged.insert(0, 'HACKED ');
    viewer.ws.send(encodeOpsFrame(docId, encodeOps(forged.getOps())));
    await eventually(() => viewer.messages.some((m) => m.type === 'error'), 'read-only error');
    expect(viewer.messages.find((m) => m.type === 'error')).toMatchObject({ code: 'read-only' });

    await tick(100);
    expect(server.peekDoc(docId)!.text).toBe('original');
    expect(writer.doc.text).toBe('original');

    // The SyncClient itself never uploads under a view capability.
    const viewerClient = peer('viewer2', docId, ws.viewToken);
    await eventually(() => viewerClient.doc.text === 'original', 'viewer catch-up');
    expect(viewerClient.client.capability(docId)).toBe('view');
    viewerClient.doc.insert(0, 'local only ');
    await tick(100);
    expect(server.peekDoc(docId)!.text).toBe('original');

    viewer.ws.close();
    writer.client.disconnect();
    viewerClient.client.disconnect();
  });

  it('rejects bad tokens, foreign agents and malformed ops', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();

    const wrongWorkspace = await rawJoin(ws.id, other.editToken, 'x1');
    expect(wrongWorkspace.messages[0]).toMatchObject({ type: 'error', code: 'bad-token' });
    wrongWorkspace.ws.close();

    // Ops for an agent the connection did not declare.
    const a = await rawJoin(ws.id, ws.editToken, 'declared');
    const foreign = new Doc({ agent: 'someone-else' });
    foreign.insert(0, 'x');
    a.ws.send(encodeOpsFrame(ws.id, encodeOps(foreign.getOps())));
    await eventually(() => a.isClosed(), 'connection closed');
    expect(a.messages.find((m) => m.type === 'error')).toMatchObject({ code: 'not-your-agent' });

    // Garbage bytes in an ops frame.
    const b = await rawJoin(ws.id, ws.editToken, 'declared2');
    b.ws.send(encodeOpsFrame(ws.id, new Uint8Array([0x54, 0x44, 1, 0, 5, 9, 9])));
    await eventually(() => b.isClosed(), 'connection closed');
    expect(b.messages.find((m) => m.type === 'error')).toMatchObject({ code: 'invalid-op' });

    // A well-encoded op that references characters that are not text.
    const c = await rawJoin(ws.id, ws.editToken, 'declared3');
    const bad = new Doc({ agent: 'declared3' });
    bad.setMeta('k', 1);
    bad.insert(0, 'y');
    const ops = bad.getOps().map((op) =>
      op.kind === 'ins' ? { ...op, originLeft: { agent: 'declared3', seq: 0 } } : op,
    );
    c.ws.send(encodeOpsFrame(ws.id, encodeOps(ops)));
    await eventually(() => c.isClosed(), 'connection closed');
    expect(c.messages.find((m) => m.type === 'error')).toMatchObject({ code: 'invalid-op' });
    // The valid op before it in the batch was applied; the invalid one was not.
    expect(server.peekDoc(ws.id)!.text).toBe('');
    expect(server.peekDoc(ws.id)!.getMeta('k')).toBe(1);
  });

  it('relays presence (name, colour, cursor) without storing it', async () => {
    const ws = await newWorkspace();
    const docId = `${ws.id}:p`;
    const a = peer('ada', docId, ws.editToken);
    const b = peer('bo', docId, ws.editToken);
    await Promise.all([a.client.whenSynced(), b.client.whenSynced()]);
    a.doc.insert(0, 'hello');
    a.client.setPresence(docId, { anchor: a.doc.cursorAt(2), head: a.doc.cursorAt(4) });
    await eventually(() => b.client.peers(docId).some((p) => p.cursor !== null), 'presence');
    await eventually(() => b.doc.text === 'hello', 'text');
    const seen = b.client.peers(docId)[0]!;
    expect(seen.user).toEqual({ name: 'ada', color: '#3366aa' });
    expect(b.doc.resolveCursor(seen.cursor!.anchor)).toBe(2);
    expect(b.doc.resolveCursor(seen.cursor!.head)).toBe(4);

    a.client.disconnect();
    await eventually(() => b.client.peers(docId).length === 0, 'leave');
    b.client.disconnect();
  });

  it('compacts a long op log into a snapshot on load', async () => {
    const ws = await newWorkspace();
    const docId = ws.id;
    const a = peer('ada', docId, ws.editToken);
    for (let i = 0; i < 30; i++) {
      a.doc.insert(a.doc.length, `${i},`);
      await a.client.whenSynced(); // one Postgres row per acknowledged batch
    }
    a.client.disconnect();
    expect((await store.loadDoc(docId)).rows.length).toBeGreaterThan(10);

    const store2 = await PgStore.connect(TEST_DB_URL);
    const server2 = await startSyncServer({ store: store2, secret: SECRET, port: 0, snapshotThreshold: 10 });
    try {
      const b = peer('bo', docId, ws.editToken, server2.url);
      await eventually(() => b.doc.text === a.doc.text, 'load after compaction');
      const after = await store.loadDoc(docId);
      expect(after.snapshot).not.toBeNull();
      expect(after.rows).toHaveLength(0);
      b.client.disconnect();
    } finally {
      await server2.close();
      await store2.close();
    }
  });
});
