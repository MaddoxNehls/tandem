import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { pageHref, parseRoute } from './boot.js';
import { loadUser, saveUser } from './lib/identity.js';
import type { Workspace } from './lib/workspace.js';
import { PageView } from './ui/PageView.js';
import { Sidebar } from './ui/Sidebar.js';
import { SearchService } from './search/service.js';
import { SearchPalette } from './ui/SearchPalette.js';
import { ToastProvider } from './ui/Toasts.js';

export function App({ ws }: { ws: Workspace }) {
  useSyncExternalStore(
    useCallback((fn) => ws.subscribe(fn), [ws]),
    () => ws.getVersion(),
  );
  const [pageId, setPageId] = useState<string | null>(() => parseRoute().pageId);
  const [user, setUser] = useState(loadUser);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [search] = useState(() => new SearchService(ws));

  // On-device search. The model (~23 MB) downloads once and is cached by the
  // browser. Automated browsers skip the download unless asked to.
  useEffect(() => {
    let pref: string | null = null;
    try {
      pref = localStorage.getItem('tandem.semantic');
    } catch {
      /* ignore */
    }
    (window as unknown as { tandemSearch: unknown }).tandemSearch = search; // e2e tests
    void search.start({ loadModel: pref === 'on' || (pref !== 'off' && !navigator.webdriver) });
  }, [search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Follow the URL.
  useEffect(() => {
    const onHash = () => setPageId(parseRoute().pageId);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Fall back to the first page when none (or a deleted one) is selected.
  const current = pageId && ws.isLive(pageId) && ws.page(pageId) ? pageId : ws.firstPage();
  useEffect(() => {
    if (current && current !== pageId) history.replaceState(null, '', pageHref(ws.id, current));
  }, [current, pageId, ws.id]);

  // Online / offline, and never lose buffered writes on close.
  useEffect(() => {
    const online = () => void ws.goOnline();
    const offline = () => ws.goOffline();
    const hide = () => void ws.flush();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', hide);
    if (navigator.onLine) online();
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [ws]);

  const open = (id: string) => {
    location.hash = pageHref(ws.id, id);
    setNavOpen(false);
  };

  const rename = (name: string) => {
    const next = { ...user, name };
    saveUser(next);
    setUser(next);
    ws.setUser(next);
  };

  return (
    <ToastProvider>
      <div className={`app${navOpen ? ' nav-open' : ''}`}>
        <Sidebar ws={ws} current={current} onOpen={open} user={user} onRename={rename} onClose={() => setNavOpen(false)} onSearch={() => setPaletteOpen(true)} />
        <main className="sheet">
          {current && ws.page(current) ? (
            <PageView key={current} ws={ws} pageId={current} search={search} onOpen={open} onOpenNav={() => setNavOpen(true)} />
          ) : (
            <div className="empty">
              <p>This notebook has no pages yet.</p>
              {!ws.readOnly && (
                <button className="btn" onClick={() => void ws.createPage().then(open)}>
                  New page
                </button>
              )}
            </div>
          )}
        </main>
      </div>
      {paletteOpen && <SearchPalette ws={ws} search={search} onOpen={open} onClose={() => setPaletteOpen(false)} />}
    </ToastProvider>
  );
}
