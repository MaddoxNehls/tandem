/**
 * Capability tokens for share links. A token grants `edit` or `view` on one
 * workspace (all of its docs):
 *
 *   token = cap + "." + base64url(HMAC-SHA256(secret, "tandem:v1:" + workspace + ":" + cap))[0..32]
 *
 * No database lookup is needed to verify a token, and the server is the only
 * party that can mint one. The workspace id itself is not secret; the token
 * is. Revocation would need a per-workspace key version (not implemented).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Capability } from '@tandem/sync';

function sign(secret: string, workspaceId: string, cap: Capability): string {
  return createHmac('sha256', secret).update(`tandem:v1:${workspaceId}:${cap}`).digest('base64url').slice(0, 32);
}

export function mintToken(secret: string, workspaceId: string, cap: Capability): string {
  return `${cap}.${sign(secret, workspaceId, cap)}`;
}

export function verifyToken(secret: string, workspaceId: string, token: unknown): Capability | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  const cap = token.slice(0, dot);
  if (cap !== 'edit' && cap !== 'view') return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, workspaceId, cap));
  return given.length === expected.length && timingSafeEqual(given, expected) ? cap : null;
}
