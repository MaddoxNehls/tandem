import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../lib/workspace.js';
import { useToast } from './Toasts.js';

export function ShareButton({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const links = ws.shareLinks();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const copy = async (url: string, what: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast(`Copied the ${what} link.`);
    } catch {
      toast('Copying was blocked. Select the link and copy it instead.');
    }
  };

  return (
    <div className="share" ref={ref}>
      <button className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Share
      </button>
      {open && (
        <div className="share-panel" role="dialog" aria-label="Share this notebook">
          {!links.edit && !links.view ? (
            <p className="share-note">Connect to the internet once to create share links for this notebook.</p>
          ) : (
            <>
              {links.edit && (
                <div className="share-row">
                  <div>
                    <strong>Can edit</strong>
                    <p>Anyone with this link can write in every page.</p>
                  </div>
                  <input readOnly value={links.edit} aria-label="Edit link" data-testid="edit-link" onFocus={(e) => e.target.select()} />
                  <button className="btn ghost" onClick={() => void copy(links.edit!, 'edit')}>
                    Copy
                  </button>
                </div>
              )}
              {links.view && (
                <div className="share-row">
                  <div>
                    <strong>Can view</strong>
                    <p>Readers see live changes but can't type.</p>
                  </div>
                  <input readOnly value={links.view} aria-label="View link" data-testid="view-link" onFocus={(e) => e.target.select()} />
                  <button className="btn ghost" onClick={() => void copy(links.view!, 'view')}>
                    Copy
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
