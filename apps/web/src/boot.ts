/**
 * Startup: open local storage, start a session, pick the workspace from the
 * URL (a share link), from the last session, or create a new one.
 *
 * Routes (hash based, so the static build works anywhere):
 *   #/w/<workspaceId>/<pageId>
 *   #/w/<workspaceId>?t=<token>     share link: joins the workspace with that capability
 */
import { loadUser, newId, startSession } from './lib/identity.js';
import { LocalStore } from './lib/storage.js';
import { lastWorkspaceId, loadRecords, saveRecord, Workspace, type WorkspaceRecord } from './lib/workspace.js';

export interface Route {
  workspaceId: string | null;
  pageId: string | null;
  token: string | null;
}

export function parseRoute(hash = location.hash): Route {
  const m = /^#\/w\/([A-Za-z0-9_-]{8,64})(?:\/([A-Za-z0-9_-]{1,64}))?(?:\?t=([A-Za-z0-9._-]+))?$/.exec(hash);
  return m ? { workspaceId: m[1]!, pageId: m[2] ?? null, token: m[3] ?? null } : { workspaceId: null, pageId: null, token: null };
}

export function pageHref(workspaceId: string, pageId: string): string {
  return `#/w/${workspaceId}/${pageId}`;
}

const WELCOME = [
  'Tandem keeps this page on your device first. It works offline, and when you share the link, edits from everyone merge without conflicts.',
  '',
  '# Writing',
  'Start a line with a marker to give it structure. The marker stays as text, so it merges like text.',
  '- # , ## and ### make headings',
  '- a dash makes a list',
  '[ ] square brackets make a to-do; click the circle to tick it off',
  '> a closing angle bracket makes a quote',
  '',
  '# Pages',
  'Add pages from the sidebar and drag one onto another to nest it.',
].join('\n');

export async function boot(): Promise<{ ws: Workspace; route: Route }> {
  const store = await LocalStore.open();
  const agents = startSession();
  const user = loadUser();
  const route = parseRoute();

  let record: WorkspaceRecord | undefined;
  if (route.workspaceId) {
    record = loadRecords().find((r) => r.id === route.workspaceId);
    if (route.token && (!record || (!record.owner && record.token !== route.token))) {
      // Joining by share link (or upgrading view -> edit).
      record = { id: route.workspaceId, token: route.token, owner: false };
    }
    if (!record) record = { id: route.workspaceId, token: null, owner: false };
  } else {
    const last = lastWorkspaceId();
    record = loadRecords().find((r) => r.id === last);
  }
  const isNew = !record;
  record ??= { id: newId('w'), token: null, owner: true };
  saveRecord(record);

  const ws = await Workspace.open(record, store, agents, user);
  if (isNew) await ws.createPage(undefined, 'Welcome to Tandem', WELCOME);

  // Keep tokens out of the visible URL once stored.
  if (route.token) history.replaceState(null, '', `#/w/${record.id}${route.pageId ? `/${route.pageId}` : ''}`);
  return { ws, route: { ...route, workspaceId: record.id } };
}
