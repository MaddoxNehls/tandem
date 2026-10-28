/**
 * SyncClient: keeps any number of local `Doc`s in sync with a Tandem sync
 * server over one WebSocket. Works in browsers and in Node (global WebSocket).
 *
 * - Local edits are uploaded (debounced to one message per tick).
 * - Remote ops are applied with `doc.applyRemote`; the doc's own change
 *   event then drives the UI.
 * - On reconnect, version vectors make catch-up exact in both directions:
 *   the server sends what we lack, and we send what the server lacks.
 * - Status is 'offline' | 'connecting' | 'syncing' | 'synced', where
 *   'synced' means every local op of ours has been acknowledged.
 */

import { decodeOps, encodeOps, type Doc, type VersionVector } from '@tandem/crdt';
import {
  covers,
  decodeOpsFrame,
  encodeOpsFrame,
  type Capability,
  type ClientMessage,
  type PeerUser,
  type PresenceCursor,
  type ServerMessage,
} from './protocol.js';

export type SyncStatus = 'offline' | 'connecting' | 'syncing' | 'synced';

export interface PeerState {
  peer: string;
  user: PeerUser;
  cursor: PresenceCursor | null;
}

export interface SyncClientOptions {
  /** e.g. ws://localhost:8790/sync */
  url: string;
  token: string;
  user: PeerUser;
  /** Agent ids whose ops this client uploads (current session + earlier offline sessions). */
  agents: () => string[];
  /** Override for environments without a global WebSocket. */
  WebSocket?: typeof WebSocket;
  /** Minimum interval between presence messages per doc. */
  presenceIntervalMs?: number;
}

interface Subscription {
  doc: Doc;
  cap: Capability | null;
  welcomed: boolean;
  /** Server version as last reported (welcome / ack). */
  acked: VersionVector;
  /** What we have uploaded (or the server already had). */
  sent: VersionVector;
  peers: Map<string, PeerState>;
  presence: PresenceCursor | null;
  presenceSentAt: number;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  flushQueued: boolean;
  off: () => void;
}

type Events = {
  status: (status: SyncStatus) => void;
  presence: (docId: string, peers: PeerState[]) => void;
  error: (error: { docId?: string | undefined; code: string; message: string }) => void;
};

export class SyncClient {
  private ws: WebSocket | null = null;
  private running = false;
  private retryMs = 250;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Map<string, Subscription>();
  private readonly listeners: { [K in keyof Events]: Set<Events[K]> } = {
    status: new Set(),
    presence: new Set(),
    error: new Set(),
  };
  private lastStatus: SyncStatus = 'offline';

  constructor(private readonly opts: SyncClientOptions) {}

  get status(): SyncStatus {
    return this.lastStatus;
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  /** Start syncing `doc` under `docId` (subscribes now if connected). */
  attach(docId: string, doc: Doc): void {
    if (this.subs.has(docId)) return;
    const sub: Subscription = {
      doc,
      cap: null,
      welcomed: false,
      acked: {},
      sent: {},
      peers: new Map(),
      presence: null,
      presenceSentAt: 0,
      presenceTimer: null,
      flushQueued: false,
      off: doc.on('change', (e) => {
        if (e.origin === 'local') this.queueFlush(docId);
        this.updateStatus();
      }),
    };
    this.subs.set(docId, sub);
    if (this.isOpen()) this.hello(docId, sub);
    this.updateStatus();
  }

  detach(docId: string): void {
    const sub = this.subs.get(docId);
    if (!sub) return;
    sub.off();
    if (sub.presenceTimer) clearTimeout(sub.presenceTimer);
    this.subs.delete(docId);
    if (this.isOpen()) this.send({ type: 'bye', docId });
    this.updateStatus();
  }

  capability(docId: string): Capability | null {
    return this.subs.get(docId)?.cap ?? null;
  }

  peers(docId: string): PeerState[] {
    return [...(this.subs.get(docId)?.peers.values() ?? [])];
  }

  /** Share this client's cursor/selection in `docId` (throttled). */
  setPresence(docId: string, cursor: PresenceCursor | null): void {
    const sub = this.subs.get(docId);
    if (!sub) return;
    sub.presence = cursor;
    if (sub.presenceTimer) return;
    const interval = this.opts.presenceIntervalMs ?? 50;
    const wait = Math.max(0, sub.presenceSentAt + interval - Date.now());
    sub.presenceTimer = setTimeout(() => {
      sub.presenceTimer = null;
      sub.presenceSentAt = Date.now();
      if (this.isOpen() && sub.welcomed) this.send({ type: 'presence', docId, cursor: sub.presence });
    }, wait);
  }

  connect(): void {
    this.running = true;
    if (this.ws) return;
    this.open();
  }

  /** Stop syncing (e.g. the browser went offline). Local editing continues. */
  disconnect(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.onClosed();
  }

  /** Resolves once the status is 'synced' (rejects after `timeoutMs`). */
  whenSynced(timeoutMs = 10_000): Promise<void> {
    if (this.lastStatus === 'synced') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`not synced after ${timeoutMs} ms (status ${this.lastStatus})`));
      }, timeoutMs);
      const off = this.on('status', (s) => {
        if (s === 'synced') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  private open(): void {
    const WS = this.opts.WebSocket ?? globalThis.WebSocket;
    const ws = new WS(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.updateStatus();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      for (const [docId, sub] of this.subs) this.hello(docId, sub);
      this.updateStatus();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onControl(JSON.parse(ev.data) as ServerMessage);
      else this.onOps(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClosed();
      if (this.running) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.running && !this.ws) this.open();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 5000);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onClosed(): void {
    for (const [docId, sub] of this.subs) {
      sub.welcomed = false;
      if (sub.peers.size > 0) {
        sub.peers.clear();
        this.emit('presence', docId, []);
      }
    }
    this.updateStatus();
  }

  private hello(docId: string, sub: Subscription): void {
    sub.welcomed = false;
    this.send({
      type: 'hello',
      docId,
      token: this.opts.token,
      agents: this.opts.agents(),
      version: sub.doc.version(),
      user: this.opts.user,
    });
  }

  private onControl(msg: ServerMessage): void {
    if (msg.type === 'error') {
      this.emit('error', { docId: msg.docId, code: msg.code, message: msg.message });
      return;
    }
    const sub = this.subs.get(msg.docId);
    if (!sub) return;
    switch (msg.type) {
      case 'welcome':
        sub.cap = msg.cap;
        sub.welcomed = true;
        sub.acked = msg.version;
        sub.sent = { ...msg.version };
        this.retryMs = 250;
        this.flush(msg.docId);
        if (sub.presence) this.send({ type: 'presence', docId: msg.docId, cursor: sub.presence });
        break;
      case 'ack':
        sub.acked = msg.version;
        break;
      case 'presence':
        sub.peers.set(msg.peer, { peer: msg.peer, user: msg.user, cursor: msg.cursor });
        this.emit('presence', msg.docId, this.peers(msg.docId));
        break;
      case 'leave':
        if (sub.peers.delete(msg.peer)) this.emit('presence', msg.docId, this.peers(msg.docId));
        break;
    }
    this.updateStatus();
  }

  private onOps(frame: Uint8Array): void {
    const { docId, ops } = decodeOpsFrame(frame);
    const sub = this.subs.get(docId);
    if (!sub) return;
    try {
      sub.doc.applyRemote(decodeOps(ops));
    } catch (err) {
      this.emit('error', { docId, code: 'invalid-op', message: String(err) });
    }
    this.updateStatus();
  }

  private queueFlush(docId: string): void {
    const sub = this.subs.get(docId);
    if (!sub || sub.flushQueued) return;
    sub.flushQueued = true;
    setTimeout(() => {
      sub.flushQueued = false;
      this.flush(docId);
    }, 0);
  }

  private flush(docId: string): void {
    const sub = this.subs.get(docId);
    if (!sub || !sub.welcomed || sub.cap !== 'edit' || !this.isOpen()) return;
    const mine = new Set(this.opts.agents());
    const ops = sub.doc.getOps(sub.sent).filter((op) => mine.has(op.agent));
    if (ops.length === 0) return;
    this.ws!.send(encodeOpsFrame(docId, encodeOps(ops)));
    sub.sent = { ...sub.sent, ...this.ownVersion(sub.doc, mine) };
  }

  private ownVersion(doc: Doc, mine: Set<string>): VersionVector {
    const out: VersionVector = {};
    for (const [agent, n] of Object.entries(doc.version())) if (mine.has(agent)) out[agent] = n;
    return out;
  }

  private send(msg: ClientMessage): void {
    if (this.isOpen()) this.ws!.send(JSON.stringify(msg));
  }

  private computeStatus(): SyncStatus {
    if (!this.ws) return 'offline';
    if (!this.isOpen()) return 'connecting';
    const mine = new Set(this.opts.agents());
    for (const sub of this.subs.values()) {
      if (!sub.welcomed) return 'syncing';
      if (sub.cap === 'edit' && !covers(sub.acked, this.ownVersion(sub.doc, mine))) return 'syncing';
    }
    return 'synced';
  }

  private updateStatus(): void {
    const s = this.computeStatus();
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.emit('status', s);
    }
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: Parameters<Events[K]>) => void)(...args);
  }
}
