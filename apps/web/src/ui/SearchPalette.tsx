import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Workspace } from '../lib/workspace.js';
import type { SearchResult } from '../search/index.js';
import { MODEL_SIZE_MB, type SearchService } from '../search/service.js';

interface Props {
  ws: Workspace;
  search: SearchService;
  onOpen: (pageId: string) => void;
  onClose: () => void;
}

function ModelNote({ search }: { search: SearchService }) {
  const s = search.modelStatus;
  switch (s.state) {
    case 'ready':
      return <span>Finds notes by meaning as well as by words.</span>;
    case 'loading':
      return <span>Downloading the search model once ({Math.round(s.progress * 100)}% of {MODEL_SIZE_MB} MB). Matching words until then.</span>;
    case 'error':
      return <span>The search model couldn't load, so results match words only. It retries when you reconnect.</span>;
    default:
      return (
        <span>
          Matching words only.{' '}
          <button className="link-btn" onClick={() => search.loadModel()}>
            Search by meaning too
          </button>{' '}
          (downloads {MODEL_SIZE_MB} MB once).
        </span>
      );
  }
}

export function SearchPalette({ ws, search, onOpen, onClose }: Props) {
  useSyncExternalStore((fn) => search.subscribe(fn), () => search.getVersion());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      void search.search(query).then((r) => {
        if (!stale) {
          setResults(r);
          setActive(0);
        }
      });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, search, search.getVersion()]); // re-run when the index changes

  const pages = query.trim()
    ? results
    : ws.root
        .pages()
        .map(([id]) => id)
        .filter((id) => ws.isLive(id))
        .map((pageId) => ({ pageId, title: ws.title(pageId), snippet: '', semantic: 0, keyword: 0, score: 0 }));

  const choose = (r: { pageId: string } | undefined) => {
    if (!r) return;
    onOpen(r.pageId);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search notes">
        <input
          ref={input}
          className="palette-input"
          placeholder="Search your notes"
          value={query}
          aria-label="Search your notes"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, pages.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') choose(pages[active]);
          }}
        />
        <ul className="palette-results" role="listbox">
          {pages.map((r, i) => (
            <li
              key={r.pageId}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span className="pr-title">{r.title || 'Untitled'}</span>
              {r.snippet && <span className="pr-snippet">{r.snippet}</span>}
              {query.trim() && (
                <span className="pr-why">{r.keyword === 0 ? 'Similar meaning' : r.semantic >= 0.3 ? 'Words and meaning' : 'Matching words'}</span>
              )}
            </li>
          ))}
          {query.trim() && pages.length === 0 && <li className="palette-empty">No notes match “{query}”.</li>}
        </ul>
        <footer className="palette-foot">
          <p className="privacy">Search runs on this device. Your notes are never sent anywhere.</p>
          <p>
            <ModelNote search={search} />
          </p>
        </footer>
      </div>
    </div>
  );
}

export function RelatedNotes({ search, pageId, onOpen }: { search: SearchService; pageId: string; onOpen: (id: string) => void }) {
  useSyncExternalStore((fn) => search.subscribe(fn), () => search.getVersion());
  const related = search.related(pageId);
  if (related.length === 0) return null;
  return (
    <aside className="related" aria-label="Related notes">
      <h2>Related notes</h2>
      <ul>
        {related.map((r) => (
          <li key={r.pageId}>
            <a href={`#${r.pageId}`} onClick={(e) => (e.preventDefault(), onOpen(r.pageId))}>
              {r.title || 'Untitled'}
            </a>
          </li>
        ))}
      </ul>
      <p>Found on this device by comparing what your notes are about.</p>
    </aside>
  );
}
