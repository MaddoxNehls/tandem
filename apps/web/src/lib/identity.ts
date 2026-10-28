/**
 * Who is writing.
 *
 * - The *user* (name + ink colour) is shown to collaborators in presence.
 * - The *agent* is the CRDT replica id. Each tab session gets a fresh one.
 *   Reusing an id across sessions risks reusing sequence numbers if a crash
 *   lost the tail of the local log, which would corrupt the document, so
 *   ids are never reused. Earlier session ids are remembered so that their
 *   unsynced offline edits can still be uploaded later.
 */
import type { PeerUser } from '@tandem/sync';

/** Collaborator inks: ultramarine, oxblood, viridian, ochre, plum. */
export const INKS = ['#2A3CB5', '#9A2B3B', '#1E7A5B', '#A87413', '#6A3E9E'] as const;
const NAMES = ['Wren', 'Juniper', 'Ada', 'Basil', 'Cleo', 'Otto', 'Iris', 'Milo', 'Sable', 'Rosa'];

const USER_KEY = 'tandem.user';
const AGENTS_KEY = 'tandem.agents';
const MAX_REMEMBERED_AGENTS = 64;

function randomId(len = 10): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export function newId(prefix = ''): string {
  return prefix + randomId(12);
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: identity just won't persist */
  }
}

export function loadUser(): PeerUser {
  const saved = read<PeerUser>(USER_KEY);
  if (saved && typeof saved.name === 'string' && typeof saved.color === 'string') return saved;
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const user = { name: NAMES[bytes[0]! % NAMES.length]!, color: INKS[bytes[1]! % INKS.length]! };
  write(USER_KEY, user);
  return user;
}

export function saveUser(user: PeerUser): void {
  write(USER_KEY, user);
}

export interface Agents {
  current: string;
  /** This session's agent plus earlier ones from this browser. */
  all(): string[];
}

export function startSession(): Agents {
  const current = `a${randomId(10)}`;
  const previous = (read<string[]>(AGENTS_KEY) ?? []).filter((a) => typeof a === 'string');
  const list = [current, ...previous].slice(0, MAX_REMEMBERED_AGENTS);
  write(AGENTS_KEY, list);
  return { current, all: () => list };
}
