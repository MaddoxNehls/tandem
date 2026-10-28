/**
 * The editor schema mirrors the CRDT exactly: the document is plain text,
 * and every line (separated by "\n" in the CRDT) is one `line` node. Block
 * structure (headings, lists, to-dos, quotes) is markdown-ish *text* at the
 * start of a line, styled by decorations (see blocks.ts). Because nothing in
 * the editor is not in the text, the mapping between ProseMirror positions
 * and CRDT offsets is exact and cheap.
 */
import { Schema } from 'prosemirror-model';

export const schema = new Schema({
  nodes: {
    doc: { content: 'line+' },
    line: {
      content: 'text*',
      group: 'block',
      parseDOM: [{ tag: 'p' }, { tag: 'div' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'li' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
  marks: {},
});
