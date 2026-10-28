import type { Workspace } from '../lib/workspace.js';

const LABELS = {
  local: { text: 'On this device', detail: 'Saved locally. Share the page to sync it.' },
  offline: { text: 'Offline', detail: 'Edits are saved on this device and will sync when you reconnect.' },
  connecting: { text: 'Connecting', detail: 'Reaching the sync server.' },
  syncing: { text: 'Syncing', detail: 'Sending and receiving changes.' },
  synced: { text: 'Synced', detail: 'Every change is saved on the server.' },
} as const;

export function StatusPill({ ws }: { ws: Workspace }) {
  const status = ws.status;
  const label = LABELS[status];
  return (
    <span className={`status status-${status}`} title={label.detail} data-status={status}>
      <span className="status-dot" aria-hidden />
      {label.text}
    </span>
  );
}
