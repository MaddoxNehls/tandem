/**
 * Markdown-ish block structure, kept as plain text in the CRDT.
 *
 * A line's leading marker decides its kind ("# " heading, "- " bullet,
 * "[ ] " to-do, "> " quote, "1. " numbered). The marker stays as real,
 * editable text; decorations style the line and hang the marker in the
 * left margin. Nothing about structure is stored outside the text, so
 * structure merges exactly like text does.
 *
 * Plan for inline formatting (bold, links): Peritext-style marks, i.e. a
 * separate CRDT of formatting spans anchored to character ids with
 * expand/no-expand rules at their boundaries (Litt et al., CSCW 2022).
 */
import { Plugin, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export type LineKind = 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'todo' | 'done' | 'quote' | 'plain';

export interface LineInfo {
  kind: LineKind;
  /** Length of the marker prefix, including its trailing space. */
  marker: number;
}

const RULES: [RegExp, (m: RegExpExecArray) => LineKind][] = [
  [/^(#{1,3}) /, (m) => (`h${m[1]!.length}` as LineKind)],
  [/^(?:[-*] )?\[([ xX])\] /, (m) => (m[1] === ' ' ? 'todo' : 'done')],
  [/^[-*] /, () => 'bullet'],
  [/^\d{1,3}[.)] /, () => 'number'],
  [/^> /, () => 'quote'],
];

export function lineInfo(text: string): LineInfo {
  for (const [re, kind] of RULES) {
    const m = re.exec(text);
    if (m) return { kind: kind(m), marker: m[0].length };
  }
  return { kind: 'plain', marker: 0 };
}

function decorate(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  const empty = state.doc.childCount === 1 && state.doc.firstChild!.content.size === 0;
  state.doc.forEach((line, pos) => {
    const info = lineInfo(line.textContent);
    const attrs: Record<string, string> = { class: `ln ln-${info.kind}` };
    if (empty) {
      attrs.class += ' is-placeholder';
      attrs['data-placeholder'] = 'Start writing. Lines that begin with #, - or [ ] become headings, lists and to-dos.';
    }
    decos.push(Decoration.node(pos, pos + line.nodeSize, attrs));
    if (info.marker > 0) {
      decos.push(Decoration.inline(pos + 1, pos + 1 + info.marker, { class: `mk mk-${info.kind}` }));
    }
  });
  return DecorationSet.create(state.doc, decos);
}

/** Toggle "[ ]" <-> "[x]" on the line containing `pos`. */
function toggleTodo(view: EditorView, pos: number): boolean {
  const $pos = view.state.doc.resolve(pos);
  const line = $pos.parent;
  const info = lineInfo(line.textContent);
  if (info.kind !== 'todo' && info.kind !== 'done') return false;
  const bracket = line.textContent.indexOf('[');
  const at = $pos.start() + bracket + 1;
  view.dispatch(view.state.tr.insertText(info.kind === 'todo' ? 'x' : ' ', at, at + 1));
  return true;
}

export const blocksPlugin = new Plugin({
  state: {
    init: (_, state) => decorate(state),
    apply: (tr, old, _oldState, newState) => (tr.docChanged ? decorate(newState) : old),
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
    handleDOMEvents: {
      mousedown(view, event) {
        const target = event.target as HTMLElement | null;
        if (!target?.classList.contains('mk-todo') && !target?.classList.contains('mk-done')) return false;
        if (!view.editable) return false;
        event.preventDefault();
        return toggleTodo(view, view.posAtDOM(target, 0));
      },
    },
  },
});

/**
 * Enter on a list line continues the list ("- ", "[ ] ", "2. "); Enter on
 * an empty list item removes its marker instead.
 */
export const continueList: Command = (state, dispatch) => {
  const { $head, empty } = state.selection;
  if (!empty) return false;
  const text = $head.parent.textContent;
  const info = lineInfo(text);
  if (!['bullet', 'number', 'todo', 'done'].includes(info.kind)) return false;
  if ($head.parentOffset < info.marker) return false;
  if (!dispatch) return true;
  if (text.length === info.marker) {
    dispatch(state.tr.delete($head.start(), $head.start() + info.marker));
    return true;
  }
  let marker = text.slice(0, info.marker);
  if (info.kind === 'done') marker = marker.replace(/\[[xX]\]/, '[ ]');
  if (info.kind === 'number') marker = marker.replace(/^\d+/, (n) => String(Number(n) + 1));
  const tr = state.tr.split($head.pos);
  tr.insertText(marker, tr.selection.from);
  tr.setSelection(TextSelection.create(tr.doc, tr.selection.from));
  dispatch(tr.scrollIntoView());
  return true;
};
