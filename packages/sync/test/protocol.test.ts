import { describe, expect, it } from 'vitest';
import { covers, decodeOpsFrame, encodeOpsFrame, workspaceOf } from '../src/index.js';

describe('protocol', () => {
  it('round-trips ops frames', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const id = 'workspace-1:page_2';
    const frame = encodeOpsFrame(id, payload);
    const { docId, ops } = decodeOpsFrame(frame);
    expect(docId).toBe(id);
    expect([...ops]).toEqual([9, 8, 7]);
  });

  it('rejects malformed frames', () => {
    expect(() => decodeOpsFrame(new Uint8Array([2, 0]))).toThrow();
    expect(() => decodeOpsFrame(new Uint8Array([1, 0x80, 0x80, 0x80, 0x80]))).toThrow();
    expect(() => decodeOpsFrame(new Uint8Array([1, 50, 1, 2]))).toThrow();
  });

  it('parses doc ids', () => {
    expect(workspaceOf('abcdefgh')).toBe('abcdefgh');
    expect(workspaceOf('abcdefgh:page1')).toBe('abcdefgh');
    expect(workspaceOf('short')).toBeNull();
    expect(workspaceOf('abcdefgh:bad/page')).toBeNull();
    expect(workspaceOf('abcdefgh:a:b')).toBeNull();
  });

  it('compares version vectors', () => {
    expect(covers({ a: 3, b: 1 }, { a: 2 })).toBe(true);
    expect(covers({ a: 1 }, { a: 2 })).toBe(false);
    expect(covers({}, {})).toBe(true);
  });
});
