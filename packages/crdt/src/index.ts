export { Doc, InvalidOpError } from './doc.js';
export type { ApplyResult, ChangeEvent, CursorRef, DocOptions } from './doc.js';
export { encodeOps, decodeOps, isSnapshot } from './encoding.js';
export type { EncodeOptions } from './encoding.js';
export type { JsonValue } from './map.js';
export { LWWMap } from './map.js';
export { MoveTree, ROOT, TRASH } from './tree.js';
export { LIMITS, opSpan, validateOp } from './ops.js';
export type {
  DeleteOp,
  DeleteRange,
  Id,
  InsertOp,
  MoveOp,
  Op,
  SetOp,
  VersionVector,
} from './ops.js';
export type { TextPatch } from './text.js';
export { diffSince, replay, restore } from './history.js';
export type { DiffSegment } from './history.js';
