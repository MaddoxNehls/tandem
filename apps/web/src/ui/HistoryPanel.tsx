import { diffSince, replay, restore, type Op } from '@tandem/crdt';
import { useEffect, useMemo, useState } from 'react';
import type { Workspace } from '../lib/workspace.js';
import { useToast } from './Toasts.js';

interface Step {
  /** Number of ops in this version (a prefix of the log). */
  count: number;
  agent: string | null;
}

/** Versions: the empty page, then one per run of ops by the same writer. */
function versions(ops: Op[]): Step[] {
  const out: Step[] = [{ count: 0, agent: null }];
  ops.forEach((op, i) => {
    const next = ops[i + 1];
    if (!next || next.agent !== op.agent) out.push({ count: i + 1, agent: op.agent });
  });
  return out;
}

export function HistoryPanel({ ws, pageId, onClose }: { ws: Workspace; pageId: string; onClose: () => void }) {
  const doc = ws.page(pageId)!;
  const toast = useToast();
  const [tick, setTick] = useState(0);
  useEffect(() => doc.on('change', () => setTick((t) => t + 1)), [doc]);

  const ops = useMemo(() => doc.getOps(), [doc, tick]);
  const steps = useMemo(() => versions(ops), [ops]);
  const latest = steps.length - 1;
  const [index, setIndex] = useState(() => Math.max(0, latest - 1));
  const step = steps[Math.min(index, latest)]!;
  const past = useMemo(() => replay(ops, step.count), [ops, step.count]);
  const segments = useMemo(() => diffSince(past, doc), [past, doc, tick]);
  const changed = segments.some((s) => s.type !== 'same');
  const who = step.agent ? (ws.author(step.agent)?.name ?? 'Someone') : null;
  const ink = step.agent ? ws.author(step.agent)?.color : undefined;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <section className="history" aria-label="Page history">
      <header className="history-head">
        <div>
          <h2>History</h2>
          <p className="history-label">
            {index >= latest ? (
              'Current version'
            ) : step.count === 0 ? (
              'Before anything was written'
            ) : (
              <>
                Version {index} of {latest}, after an edit by{' '}
                <span className="history-author" style={{ color: ink }}>
                  {who}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="history-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn"
            disabled={!changed || ws.readOnly}
            onClick={() => {
              const r = restore(doc, past);
              toast(`Restored version ${index}: ${r.deleted} characters removed, ${r.inserted} brought back.`);
              onClose();
            }}
          >
            Restore this version
          </button>
        </div>
      </header>

      <input
        className="history-slider"
        type="range"
        min={0}
        max={latest}
        value={Math.min(index, latest)}
        onChange={(e) => setIndex(Number(e.target.value))}
        aria-label="Version"
        aria-valuetext={index >= latest ? 'Current version' : `Version ${index}`}
      />
      <p className="history-key">
        Compared with now: <ins>added since</ins> <del>removed since</del>. Restoring adds new edits on top, so collaborators get it too and nothing is lost.
      </p>

      <div className="history-text">
        {segments.map((s, i) =>
          s.type === 'same' ? (
            <span key={i}>{s.text}</span>
          ) : s.type === 'inserted' ? (
            <ins key={i}>{s.text}</ins>
          ) : (
            <del key={i}>{s.text}</del>
          ),
        )}
      </div>
    </section>
  );
}
