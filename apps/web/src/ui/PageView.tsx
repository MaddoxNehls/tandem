import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor } from '../editor/Editor.js';
import type { Workspace } from '../lib/workspace.js';
import { ShareButton } from './ShareButton.js';
import { StatusPill } from './StatusPill.js';

interface PageViewProps {
  ws: Workspace;
  pageId: string;
  onOpenNav: () => void;
}

export function PageView({ ws, pageId, onOpenNav }: PageViewProps) {
  const doc = ws.page(pageId)!;
  const readOnly = ws.readOnly;
  const title = ws.title(pageId);
  const [draft, setDraft] = useState(title);
  const editingTitle = useRef(false);

  // Remote renames show up unless the title field is being edited.
  useEffect(() => {
    if (!editingTitle.current) setDraft(title);
  }, [title]);

  const onSelection = useCallback(
    (anchor: number, head: number) => ws.setPresence(pageId, { anchor: doc.cursorAt(anchor), head: doc.cursorAt(head) }),
    [ws, pageId, doc],
  );

  const peers = ws.peers(pageId);

  return (
    <>
      <header className="topbar">
        <button className="btn ghost nav-open-btn" onClick={onOpenNav}>
          Pages
        </button>
        <StatusPill ws={ws} />
        <div className="topbar-end">
          {peers.length > 0 && (
            <ul className="peers" aria-label="Also here">
              {peers.map((p) => (
                <li key={p.peer} style={{ '--ink': p.user.color } as React.CSSProperties} title={p.user.name}>
                  {p.user.name}
                </li>
              ))}
            </ul>
          )}
          {readOnly ? <span className="badge">View only</span> : <ShareButton ws={ws} />}
        </div>
      </header>

      <article className="page">
        <textarea
          className="title"
          rows={1}
          value={draft}
          placeholder="Untitled"
          readOnly={readOnly}
          autoFocus={title === '' && !readOnly}
          aria-label="Page title"
          onFocus={() => (editingTitle.current = true)}
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, ' ');
            setDraft(v);
            ws.rename(pageId, v);
          }}
          onBlur={() => (editingTitle.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (document.querySelector('.editor .ProseMirror') as HTMLElement | null)?.focus();
            }
          }}
        />
        <Editor doc={doc} readOnly={readOnly} peers={peers} onSelection={onSelection} autoFocus={title !== ''} />
      </article>
    </>
  );
}
