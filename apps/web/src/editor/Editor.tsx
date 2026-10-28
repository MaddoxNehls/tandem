import type { Doc } from '@tandem/crdt';
import type { PeerState } from '@tandem/sync';
import { baseKeymap, chainCommands, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef } from 'react';
import { applyLocalTransaction, docFromText, posToOffset, remoteTransaction, REMOTE } from './binding.js';
import { blocksPlugin, continueList } from './blocks.js';
import { presenceKey, presencePlugin, type RemoteCursor } from './presence.js';

/**
 * Pull a pending DOM selection (e.g. from a click whose 'selectionchange'
 * hasn't been processed yet) into the editor state. Any transaction we
 * dispatch on our own (remote edits, presence) must start from it, or
 * ProseMirror writes the stale selection back over the user's click.
 */
function syncFromDom(view: EditorView): void {
  (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
}

/**
 * Key commands read `state.selection`, which lags the DOM until the browser's
 * 'selectionchange' is processed. A key pressed right after a caret move (End,
 * a click) would otherwise act at the old position, e.g. Enter splitting the
 * first line instead of the line the caret is on.
 */
const withDomSelection =
  (cmd: Command): Command =>
  (state, dispatch, view) => {
    if (!view) return cmd(state, dispatch);
    syncFromDom(view);
    return cmd(view.state, dispatch && view.dispatch, view);
  };

const freshKeymap = (bindings: Record<string, Command>) =>
  keymap(Object.fromEntries(Object.entries(bindings).map(([key, cmd]) => [key, withDomSelection(cmd)])));

const selectionKey = (cursors: RemoteCursor[]) =>
  cursors.map((c) => (c.anchor === c.head ? '' : `${c.peer}:${c.anchor}:${c.head}`)).join('|');

interface EditorProps {
  doc: Doc;
  readOnly: boolean;
  peers: PeerState[];
  onSelection: (anchor: number, head: number) => void;
  autoFocus?: boolean;
}

export function Editor({ doc, readOnly, peers, onSelection, autoFocus }: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const peersRef = useRef(peers);
  const readOnlyRef = useRef(readOnly);
  const onSelectionRef = useRef(onSelection);
  const presenceRef = useRef<{ redrawCarets(): void; cursors(): RemoteCursor[]; drawnSelections: string } | null>(null);
  onSelectionRef.current = onSelection;

  useEffect(() => {
    const cursors = (): RemoteCursor[] =>
      peersRef.current.flatMap((p) => {
        if (!p.cursor) return [];
        const anchor = doc.resolveCursor(p.cursor.anchor);
        const head = doc.resolveCursor(p.cursor.head);
        return anchor === null || head === null ? [] : [{ peer: p.peer, ...p.user, anchor, head }];
      });

    const presence = presencePlugin(cursors);
    presenceRef.current = { redrawCarets: presence.redrawCarets, cursors, drawnSelections: selectionKey(cursors()) };

    const state = EditorState.create({
      doc: docFromText(doc.text),
      plugins: [
        history(),
        freshKeymap({ Enter: chainCommands(continueList, splitBlock), 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
        freshKeymap(baseKeymap),
        blocksPlugin,
        presence.plugin,
      ],
    });

    const view = new EditorView(mount.current!, {
      state,
      editable: () => !readOnlyRef.current,
      attributes: { class: 'prose', spellcheck: 'true', 'aria-label': 'Page text', role: 'textbox', 'aria-multiline': 'true' },
      dispatchTransaction(tr) {
        if (!tr.getMeta(REMOTE)) applyLocalTransaction(doc, tr);
        view.updateState(view.state.apply(tr));
        if (tr.selectionSet || tr.docChanged) {
          const sel = view.state.selection;
          onSelectionRef.current(posToOffset(view.state.doc, sel.anchor), posToOffset(view.state.doc, sel.head));
        }
      },
    });
    viewRef.current = view;
    if (autoFocus && !readOnlyRef.current) view.focus();

    const off = doc.on('change', (e) => {
      if (e.origin === 'remote' && e.text.length > 0) {
        syncFromDom(view);
        view.dispatch(remoteTransaction(view.state, e.text));
      }
    });
    return () => {
      off();
      view.destroy();
      viewRef.current = null;
    };
    // The editor is recreated per doc; other props flow through refs.
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    peersRef.current = peers;
    const view = viewRef.current;
    const presence = presenceRef.current;
    if (!view || !presence) return;
    // Carets live in an overlay: just redraw. Selection highlights are
    // decorations, so they need a (rare) transaction when they change.
    const key = selectionKey(presence.cursors());
    if (key !== presence.drawnSelections) {
      presence.drawnSelections = key;
      syncFromDom(view);
      view.dispatch(view.state.tr.setMeta(presenceKey, true).setMeta(REMOTE, true));
    } else {
      presence.redrawCarets();
    }
  }, [peers]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    viewRef.current?.setProps({});
  }, [readOnly]);

  return <div className="editor" ref={mount} />;
}
