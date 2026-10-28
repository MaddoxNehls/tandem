/**
 * Remote cursors and selections. Collaborators' positions arrive as CRDT
 * cursor refs (character ids), so they stay attached to the right text no
 * matter what else changed; they are resolved to positions on every render.
 *
 * Selections are inline decorations (plain styled spans). Carets are NOT
 * widgets inside the editable text: a non-editable inline element at the
 * end of a line breaks the browser's own caret movement (Ctrl+End stops
 * before it, clicks land in the wrong place). Instead they are drawn in an
 * overlay layer, positioned with `view.coordsAtPos`.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { offsetToPos } from './binding.js';

export interface RemoteCursor {
  peer: string;
  name: string;
  color: string;
  /** Text offsets. */
  anchor: number;
  head: number;
}

export const presenceKey = new PluginKey('tandem-presence');

export interface Presence {
  plugin: Plugin;
  /** Redraw carets without touching editor state (cheap; no transaction). */
  redrawCarets(): void;
}

/** `getCursors` is called on every render, after the CRDT and editor agree. */
export function presencePlugin(getCursors: () => RemoteCursor[]): Presence {
  let redraw = () => {};
  const clampPos = (view: EditorView['state']['doc'], offset: number) =>
    Math.min(offsetToPos(view, offset), view.content.size);

  const plugin = new Plugin({
    key: presenceKey,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        for (const c of getCursors()) {
          const a = clampPos(state.doc, c.anchor);
          const h = clampPos(state.doc, c.head);
          if (a !== h) {
            decos.push(Decoration.inline(Math.min(a, h), Math.max(a, h), { class: 'rsel', style: `--ink: ${c.color}` }));
          }
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
    view(view) {
      const layer = document.createElement('div');
      layer.className = 'rcarets';
      layer.setAttribute('aria-hidden', 'true');
      view.dom.parentElement!.append(layer);

      const draw = () => {
        const origin = layer.getBoundingClientRect();
        const carets = getCursors().map((c) => {
          const coords = view.coordsAtPos(clampPos(view.state.doc, c.head));
          const caret = document.createElement('div');
          caret.className = 'rcaret';
          caret.style.setProperty('--ink', c.color);
          caret.style.left = `${coords.left - origin.left}px`;
          caret.style.top = `${coords.top - origin.top}px`;
          caret.style.height = `${coords.bottom - coords.top}px`;
          const tag = document.createElement('span');
          tag.className = 'rcaret-name';
          tag.textContent = c.name;
          caret.append(tag);
          return caret;
        });
        layer.replaceChildren(...carets);
      };

      // Layout changes that ProseMirror doesn't see: web fonts, resizes.
      const ro = new ResizeObserver(draw);
      ro.observe(view.dom);
      void document.fonts?.ready.then(draw);
      draw();
      redraw = draw;
      return {
        update: draw,
        destroy() {
          ro.disconnect();
          layer.remove();
          redraw = () => {};
        },
      };
    },
  });
  return { plugin, redrawCarets: () => redraw() };
}
