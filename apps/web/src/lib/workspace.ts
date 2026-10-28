/**
 * A workspace is one notebook: a root doc (page tree + page titles) and one
 * doc per page (its body). All of them are
 *   - loaded from and persisted to IndexedDB (instant, offline reloads),
 *   - relayed between tabs of this browser (BroadcastChannel),
 *   - synced with the server once the workspace has a token.
 *
 * Doc ids: the root doc is `<workspaceId>`, a page is `<workspaceId>:<pageId>`.
 */
import { decodeOps, Doc, encodeOps, ROOT, TRASH } from '@tandem/crdt';
import { SyncClient, type Capability, type PeerState, type PeerUser, type SyncStatus } from '@tandem/sync';
import { newId, type Agents } from './identity.js';
import { DocPersister, loadDoc, type LocalStore } from './storage.js';

export interface WorkspaceRecord {
  id: string;
  /** Token used to sync (edit or view). Null until an owned workspace is claimed. */
  token: string | null;
  editToken?: string;
  viewToken?: string;
  /** Created in this browser (and claimed by it). */
  owner: boolean;
}

export type WorkspaceStatus = SyncStatus | 'local';

export interface PageNode {
  id: string;
  title: string;
  children: PageNode[];
}

const RECORDS_KEY = 'tandem.workspaces';
const LAST_KEY = 'tandem.lastWorkspace';

export function loadRecords(): WorkspaceRecord[] {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]') as WorkspaceRecord[];
  } catch {
    return [];
  }
}

export function saveRecord(record: WorkspaceRecord): void {
  const records = loadRecords().filter((r) => r.id !== record.id);
  records.unshift(record);
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  localStorage.setItem(LAST_KEY, record.id);
}

export function lastWorkspaceId(): string | null {
  return localStorage.getItem(LAST_KEY);
}

const titleKey = (pageId: string) => `title:${pageId}`;

export class Workspace {
  private readonly pages = new Map<string, Doc>();
  private readonly loading = new Map<string, Promise<Doc>>();
  private readonly persisters: DocPersister[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;
  private client: SyncClient | null = null;
  private version = 0;
  private claiming = false;

  private constructor(
    public record: WorkspaceRecord,
    readonly root: Doc,
    private readonly store: LocalStore,
    private readonly agents: Agents,
    private user: PeerUser,
  ) {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`tandem:${record.id}`);
    this.channel?.addEventListener('message', (e: MessageEvent<{ docId: string; bytes: Uint8Array }>) => {
      const doc = e.data.docId === this.record.id ? this.root : this.pages.get(this.pageIdOf(e.data.docId));
      doc?.applyRemote(decodeOps(e.data.bytes));
    });
  }

  static async open(record: WorkspaceRecord, store: LocalStore, agents: Agents, user: PeerUser): Promise<Workspace> {
    const { doc: root, rows } = await loadDoc(store, record.id, agents.current);
    const ws = new Workspace(record, root, store, agents, user);
    ws.track(record.id, root, rows);
    root.on('change', (e) => {
      if (e.tree) void ws.loadAllPages();
      ws.bump();
    });
    await ws.loadAllPages();
    return ws;
  }

  // --- reactive plumbing -----------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // --- pages ---------------------------------------------------------------

  get id(): string {
    return this.record.id;
  }

  get readOnly(): boolean {
    return this.client?.capability(this.id) === 'view' || (!this.record.owner && this.record.token?.startsWith('view.') === true);
  }

  page(pageId: string): Doc | undefined {
    return this.pages.get(pageId);
  }

  title(pageId: string): string {
    const t = this.root.getMeta(titleKey(pageId));
    return typeof t === 'string' ? t : '';
  }

  rename(pageId: string, title: string): void {
    if (title !== this.title(pageId)) this.root.setMeta(titleKey(pageId), title);
  }

  tree(parent: string = ROOT): PageNode[] {
    return this.root
      .pageChildren(parent)
      .map((id) => ({ id, title: this.title(id), children: this.tree(id) }));
  }

  /** First live page, depth-first. */
  firstPage(): string | null {
    const walk = (nodes: PageNode[]): string | null => (nodes[0] ? nodes[0].id : null);
    return walk(this.tree());
  }

  async createPage(parent: string = ROOT, title = '', body = ''): Promise<string> {
    // Time-ordered ids keep sibling order (sorted by id) = creation order.
    const id = `${Date.now().toString(36).padStart(9, '0')}${newId().slice(0, 6)}`;
    const doc = await this.ensurePage(id);
    if (body) doc.insert(0, body);
    this.root.setMeta(titleKey(id), title);
    this.root.movePage(id, parent);
    return id;
  }

  /** Returns false if the move would put a page inside its own subtree. */
  movePage(pageId: string, parent: string): boolean {
    if (this.root.pageParent(pageId) === parent) return true;
    return this.root.movePage(pageId, parent);
  }

  deletePage(pageId: string): void {
    this.root.movePage(pageId, TRASH);
  }

  isLive(pageId: string): boolean {
    return this.root.isPageLive(pageId);
  }

  // --- sync ----------------------------------------------------------------

  get status(): WorkspaceStatus {
    if (this.client) return this.client.status;
    // Shared notebooks opened without a connection are offline, not local-only.
    return this.record.token ? 'offline' : 'local';
  }

  peers(pageId: string): PeerState[] {
    return this.client?.peers(this.docId(pageId)) ?? [];
  }

  setPresence(pageId: string, cursor: Parameters<SyncClient['setPresence']>[1]): void {
    this.client?.setPresence(this.docId(pageId), cursor);
  }

  setUser(user: PeerUser): void {
    this.user = user;
    if (this.authorRecorded) this.root.setMeta(`author:${this.agents.current}`, { name: user.name, color: user.color });
    // Re-handshake so collaborators see the new name.
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.startSync();
    }
  }

  capability(): Capability | null {
    return this.client?.capability(this.id) ?? null;
  }

  shareLinks(): { edit: string | null; view: string | null } {
    const base = `${location.origin}${location.pathname}#/w/${this.id}?t=`;
    const r = this.record;
    const edit = r.editToken ?? (r.token?.startsWith('edit.') ? r.token : null);
    const view = r.viewToken ?? (r.token?.startsWith('view.') ? r.token : null);
    return { edit: edit ? base + edit : null, view: view ? base + view : null };
  }

  /** Claim (if needed) and start syncing. Safe to call repeatedly. */
  async goOnline(): Promise<void> {
    if (!this.record.token && this.record.owner && !this.claiming) {
      this.claiming = true;
      try {
        const res = await fetch(`/api/workspaces/${this.id}/claim`, { method: 'POST' });
        if (res.ok) {
          const t = (await res.json()) as { editToken: string; viewToken: string };
          this.record = { ...this.record, token: t.editToken, editToken: t.editToken, viewToken: t.viewToken };
          saveRecord(this.record);
        }
      } catch {
        /* offline: stay local, retry on the next 'online' event */
      } finally {
        this.claiming = false;
      }
    }
    if (this.record.token) this.startSync();
    this.client?.connect();
    this.bump();
  }

  goOffline(): void {
    this.client?.disconnect();
    this.bump();
  }

  flush(): Promise<void> {
    return Promise.all(this.persisters.map((p) => p.flush())).then(() => undefined);
  }

  private startSync(): void {
    if (this.client || !this.record.token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new SyncClient({
      url: `${proto}://${location.host}/sync`,
      token: this.record.token,
      user: this.user,
      agents: () => this.agents.all(),
    });
    client.on('status', () => this.bump());
    client.on('presence', () => this.bump());
    client.on('error', (e) => console.warn('sync error', e));
    client.attach(this.id, this.root);
    for (const [pageId, doc] of this.pages) client.attach(this.docId(pageId), doc);
    this.client = client;
  }

  // --- internals -------------------------------------------------------------

  docId(pageId: string): string {
    return `${this.id}:${pageId}`;
  }

  private pageIdOf(docId: string): string {
    return docId.slice(this.id.length + 1);
  }

  private async loadAllPages(): Promise<void> {
    await Promise.all(this.root.pages().map(([id]) => this.ensurePage(id)));
  }

  private ensurePage(pageId: string): Promise<Doc> {
    const existing = this.loading.get(pageId);
    if (existing) return existing;
    const p = loadDoc(this.store, this.docId(pageId), this.agents.current).then(({ doc, rows }) => {
      this.pages.set(pageId, doc);
      this.track(this.docId(pageId), doc, rows);
      this.client?.attach(this.docId(pageId), doc);
      this.bump();
      return doc;
    });
    this.loading.set(pageId, p);
    return p;
  }

  private track(docId: string, doc: Doc, rows: number): void {
    this.persisters.push(new DocPersister(this.store, docId, doc, rows));
    const pageId = docId === this.id ? null : this.pageIdOf(docId);
    doc.on('change', (e) => {
      if (e.origin === 'local' && this.channel) this.channel.postMessage({ docId, bytes: encodeOps(e.ops) });
      if (e.origin === 'local' && pageId) this.recordAuthor();
      for (const fn of this.docListeners) fn(pageId);
    });
  }

  // --- change feed and authorship -------------------------------------------

  private readonly docListeners = new Set<(pageId: string | null) => void>();
  private authorRecorded = false;

  /** Called after any doc changes: a page id, or null for the root doc (tree, titles). */
  onDocChange(fn: (pageId: string | null) => void): () => void {
    this.docListeners.add(fn);
    return () => this.docListeners.delete(fn);
  }

  /** Name and ink of whoever wrote with `agent` (recorded in the root doc's map). */
  author(agent: string): PeerUser | null {
    const a = this.root.getMeta(`author:${agent}`);
    return a && typeof a === 'object' && !Array.isArray(a) && typeof a.name === 'string' && typeof a.color === 'string'
      ? { name: a.name, color: a.color }
      : null;
  }

  /** Once per session, on the first edit: map this session's agent id to the user. */
  private recordAuthor(): void {
    if (this.authorRecorded || this.readOnly) return;
    this.authorRecorded = true;
    this.root.setMeta(`author:${this.agents.current}`, { name: this.user.name, color: this.user.color });
  }
}
