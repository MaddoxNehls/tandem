import { ROOT } from '@tandem/crdt';
import type { PeerUser } from '@tandem/sync';
import { useState, type DragEvent } from 'react';
import type { PageNode, Workspace } from '../lib/workspace.js';
import { useToast } from './Toasts.js';

interface SidebarProps {
  ws: Workspace;
  current: string | null;
  onOpen: (pageId: string) => void;
  user: PeerUser;
  onRename: (name: string) => void;
  onClose: () => void;
}

const DRAG_TYPE = 'application/x-tandem-page';

export function Sidebar({ ws, current, onOpen, user, onRename, onClose }: SidebarProps) {
  const toast = useToast();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const readOnly = ws.readOnly;

  const drop = (e: DragEvent, parent: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (!id || id === parent) {
      if (id) toast("A page can't be moved inside itself.");
      return;
    }
    if (!ws.movePage(id, parent)) toast("A page can't be moved inside one of its own subpages.");
  };

  const dropProps = (parent: string) =>
    readOnly
      ? {}
      : {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(parent);
          },
          onDragLeave: () => setDropTarget((t) => (t === parent ? null : t)),
          onDrop: (e: DragEvent) => drop(e, parent),
        };

  const renderNodes = (nodes: PageNode[]) => (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.id}>
          <div
            className={`tree-row${n.id === current ? ' is-current' : ''}${dropTarget === n.id ? ' is-drop' : ''}`}
            draggable={!readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, n.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            {...dropProps(n.id)}
          >
            <a href={`#/w/${ws.id}/${n.id}`} onClick={(e) => (e.preventDefault(), onOpen(n.id))} aria-current={n.id === current ? 'page' : undefined}>
              {n.title || 'Untitled'}
            </a>
            {!readOnly && (
              <span className="tree-actions">
                <button
                  className="icon-btn"
                  title="Add a subpage"
                  aria-label={`Add a page inside ${n.title || 'Untitled'}`}
                  onClick={() => void ws.createPage(n.id).then(onOpen)}
                >
                  +
                </button>
                <button
                  className="icon-btn"
                  title="Delete page"
                  aria-label={`Delete ${n.title || 'Untitled'}`}
                  onClick={() => {
                    ws.deletePage(n.id);
                    toast(`Deleted “${n.title || 'Untitled'}”.`);
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </div>
          {n.children.length > 0 && renderNodes(n.children)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav className="sidebar" aria-label="Pages">
      <div className="brand">
        <span className="wordmark">Tandem</span>
        <button className="icon-btn nav-close" aria-label="Close pages" onClick={onClose}>
          ×
        </button>
      </div>

      <div className={`tree-root${dropTarget === ROOT ? ' is-drop' : ''}`} {...dropProps(ROOT)}>
        {renderNodes(ws.tree())}
        {!readOnly && (
          <button className="new-page" onClick={() => void ws.createPage().then(onOpen)}>
            New page
          </button>
        )}
        {!readOnly && <p className="hint">Drag a page onto another to nest it, or here to move it to the top.</p>}
      </div>

      <div className="me">
        <span className="ink-dot" style={{ background: user.color }} aria-hidden />
        {editingName ? (
          <input
            className="name-input"
            autoFocus
            defaultValue={user.name}
            maxLength={40}
            aria-label="Your name"
            onBlur={(e) => {
              setEditingName(false);
              if (e.target.value.trim()) onRename(e.target.value.trim());
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button className="name" onClick={() => setEditingName(true)} title="Change the name collaborators see">
            {user.name}
          </button>
        )}
      </div>
    </nav>
  );
}
