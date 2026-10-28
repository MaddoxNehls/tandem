# Tandem

A local-first collaborative notes app. Your notes live on your device first:
edits apply instantly, survive being offline, and merge without conflicts when
you reconnect. The merging is done by a **CRDT written from scratch**
([`packages/crdt`](packages/crdt/README.md)), not a library.

Status: milestones 1-4 of the [spec](docs/spec.md) and the version-history
part of milestone 5 are done:
- CRDT core;
- editor with local persistence and offline support;
- sync server with presence and share links;
- on-device semantic search;
- version history with restore.

Deployment is next.

![Ada's view: Basil's cursor and selection on "shoes", his name in the header](docs/screenshots/collaboration-ada.png)

| Writing | Basil's view of the same page | Offline, edits kept locally |
|---|---|---|
| ![Editor](docs/screenshots/editor.png) | ![Basil's view](docs/screenshots/collaboration-basil.png) | ![Offline](docs/screenshots/offline.png) |

| Search by meaning (on-device model) | Related notes | Version history: diff and restore |
|---|---|---|
| ![Search palette](docs/screenshots/search.png) | ![Related notes](docs/screenshots/related.png) | ![History](docs/screenshots/history.png) |

All screenshots are taken by the Playwright end-to-end tests
(`apps/web/e2e/`) in real browser contexts.

## Run it

You need Node 24, pnpm 11 and Docker (for Postgres on host port **5448**).

```sh
pnpm install
pnpm start          # Postgres up, build everything, serve app + sync on http://127.0.0.1:8790
```

Open http://127.0.0.1:8790. A notebook is created on first visit. Use
**Share** to copy an edit or view link, and open it in another browser
profile to collaborate.

For development with hot reload:

```sh
pnpm dev            # Postgres + sync server (tsx watch, :8790) + Vite (http://localhost:5190, proxies /api and /sync)
```

Checks:

```sh
pnpm typecheck      # every package
pnpm test           # unit + property tests, and the server integration tests (starts Postgres via docker compose)
pnpm build
pnpm e2e            # builds the web app, then Playwright against the real server + Postgres
```

Environment for the server: `PORT` (8790), `DATABASE_URL`
(`postgres://tandem:tandem@localhost:5448/tandem`), `TANDEM_SECRET`
(HMAC key for share tokens; a development default is used with a warning)
and `STATIC_DIR`.

## Architecture

```
 Browser tab                                                     Sync server (Node + ws)
┌───────────────────────────────────────────────┐              ┌───────────────────────────────┐
│ React UI: sidebar (page tree), page, presence │              │ per-doc room: authoritative   │
│        │                     ▲                │              │ Doc replica (Fugue/LWW/tree)  │
│        ▼  PM transactions    │ TextPatches    │   binary     │  validate → apply → broadcast │
│ ProseMirror ◀── binding ──▶ Doc (CRDT)  ──────┼── ops ⇄ ────▶│  batch-append to Postgres     │
│                              │   ▲            │  JSON ctrl   │  ack once durable             │
│            DocPersister ─────┘   │            │  presence    │ capability tokens (HMAC)      │
│                 │      BroadcastChannel (tabs)│              └──────────────┬────────────────┘
│                 ▼                             │                             ▼
│ IndexedDB: op-log batches + snapshots         │              Postgres: doc_ops (append-only
│ Service worker: app shell offline (PWA)       │              batches) + doc_snapshots
└───────────────────────────────────────────────┘
```

| Package | What it is |
|---|---|
| [`packages/crdt`](packages/crdt/README.md) | Fugue text (RLE spans in a B-tree), LWW map, movable tree, `Doc` with version vectors and causal buffering, binary encoding, op validation. Property-tested, benchmarked against Yjs and Automerge. |
| `packages/sync` | Wire protocol (framing, message types) and `SyncClient`. The client is shared by the browser app and by the Node integration tests. |
| `apps/sync` | Sync server: WebSocket rooms, Postgres persistence, share tokens, presence relay. In production mode it also serves the built web app. |
| `apps/web` | Vite + React + ProseMirror app: editor binding, pages sidebar, IndexedDB persistence, PWA. |

### Data model

A notebook (*workspace*) is a set of CRDT documents:

- the **root doc** `<workspace>`, holding the page hierarchy (movable tree)
  and page titles (LWW map keys `title:<pageId>`);
- one **page doc** per page, `<workspace>:<pageId>`, holding the body text
  (Fugue).

Every browser tab is a fresh CRDT replica (a new *agent id* per session).
Reusing an id after a crash could reuse sequence numbers whose ops were
never persisted, which would corrupt the document, so ids are never reused.
The ids of earlier sessions are remembered, so their unsynced offline edits
are still uploaded the next time any tab connects.

### Editor binding (`apps/web/src/editor`)

The editor mirrors the CRDT exactly. The document is plain text, and each
line is one ProseMirror `line` node, so a CRDT offset `o` on line `k` is
ProseMirror position `o + k + 1`.

- **Local edits.** Each ProseMirror transaction is diffed against the
  previous text into at most one delete plus one insert. The transaction's
  first changed position is used as a hint, so typing "a" inside "aa" is
  attributed to the right place.
- **Remote edits.** The doc's `change` event carries `TextPatch`es in
  visible positions. These become one ProseMirror transaction, kept out of
  undo history. A multi-line insert becomes an open slice that splits the
  line, exactly like a paste.
- **Selection.** The selection is mapped through the patches in CRDT
  offsets, sticking *left* of a remote insert at the caret, so a
  collaborator typing exactly where you are doesn't push your caret.
  Pending DOM selections (a click whose `selectionchange` hasn't fired yet)
  are flushed into the state before any remote transaction is dispatched.
  The e2e test caught that race.
- **Block structure** is markdown-ish *text*: `# ` headings, `- ` lists,
  `[ ] ` to-dos, `> ` quotes, `1. ` numbered items. Decorations style the
  line and hang the marker in the margin. Enter continues a list, and Enter
  on an empty item ends it. Clicking a to-do circle edits the `[ ]`
  characters. Since structure is text, it merges like text.
- **Planned: inline marks.** Bold, italic and links would be a
  Peritext-style mark CRDT (Litt et al., CSCW 2022): formatting spans
  anchored to character ids, with per-mark rules for whether a span
  expands when text is typed at its edges. They stay out of the text CRDT,
  so concurrent formatting and typing don't conflict.
- **Presence.** Collaborators' cursors are sent as CRDT cursor refs (the id
  of the char left of the caret), so they stay attached to the right text
  through any concurrent edits. Remote selections are inline decorations.
  Remote carets and name tags are drawn in an overlay layer, not as inline
  widgets, because a non-editable inline element at the end of a line broke
  the browser's own caret movement (Ctrl+End, clicks).

### Local persistence and offline

- **IndexedDB.** Every op a doc applies, local or remote, is buffered for
  150 ms and appended as one batch row (`encodeOps` bytes). Every 100 rows,
  a snapshot (`doc.save()`) replaces the rows it covers. Reload = snapshot +
  tail, before any network round trip. Buffered writes are flushed on
  `pagehide` and `visibilitychange`.
- **Other tabs** receive local ops over a `BroadcastChannel`, so two tabs
  stay in sync even while offline.
- **Service worker** (vite-plugin-pwa, Workbox): precaches the app shell
  and fonts. The e2e test reloads a page with the network disabled and gets
  the app with its content.
- **Status indicator:**
  - *Offline*: no connection.
  - *Syncing*: connected, but local ops not yet acknowledged.
  - *Synced*: the server has made every local op durable.
  - *On this device*: a notebook that has never been shared.

### Sync protocol (`packages/sync/src/protocol.ts`)

One WebSocket carries any number of documents. Control messages are JSON;
ops are binary frames (`0x01, docId, encodeOps(...)`) reusing the CRDT
encoder.

```
client                                        server
  hello {docId, token, agents, version}  ──▶    verify token (edit|view), load room
                                         ◀──    ops the client lacks: doc.getOps(client version)
                                         ◀──    welcome {cap, version}
  ops the server lacks (own agents only) ──▶    validate, apply, broadcast, persist
                                         ◀──    ack {version}   (after the Postgres batch commits)
  live: ops ⇄, presence ⇄ (throttled to 50 ms per doc, never stored)
```

Catch-up after offline is exact in both directions: each side sends what
the other's version vector lacks.

### Server and security model

- **Share links** carry a capability token,
  `cap.HMAC-SHA256(secret, workspace:cap)`, for `edit` or `view` on one
  workspace. Verifying one needs no database lookup. A workspace is
  *claimed* once (`POST /api/workspaces/:id/claim`), which returns both
  tokens to its creator. View-only is enforced on the server: ops from a
  view connection are rejected with `read-only` and never applied.
- **Validation of incoming ops**, in order:
  1. frame and encoding decode;
  2. every op's agent must be one the connection declared in `hello`;
  3. `validateOp` checks types, bounds and self-references;
  4. `applyRemote` checks that referenced ids exist *and* are characters,
     before mutating anything;
  5. the number of ops buffered for missing dependencies is capped.

  A violation sends an error and closes the connection. Ops applied before
  the bad one in a batch are still broadcast and persisted.
- **Persistence**: one `doc_ops` row per 25 ms flush window. Loading a doc
  reads its snapshot plus the following rows. When more than 200 rows
  follow the snapshot, a new snapshot is written and the covered rows are
  deleted ("snapshot on load").

### On-device semantic search (`apps/web/src/search`)

Nothing about your notes leaves the device. The UI says so in the search
palette, and the only network traffic is the one-time model download.

- **Model.** `Xenova/all-MiniLM-L6-v2`, 8-bit quantized (~23 MB), runs in
  a Web Worker with transformers.js (ONNX Runtime Web, WASM). The weights
  come from the Hugging Face CDN once and are cached by the browser. A
  Workbox cache-first rule also keeps the model and runtime available
  offline, and the e2e test reloads with the network off and still gets
  results by meaning.
- **Chunks.** One per paragraph, heading or list item (markers stripped,
  long paragraphs split at sentences), plus the title. They are
  *content-addressed*: the vector for a chunk is stored in IndexedDB under
  `model:hash(text)`. After an edit, only lines whose text changed are
  embedded; moving a paragraph or reloading costs nothing. Unused vectors
  are pruned.
- **Re-indexing.** It follows every doc change, local or from a
  collaborator. It is debounced (1.2 s) with a max wait (3.6 s), so a page
  that never stops changing is still indexed.
- **Ranking.** Each page's semantic score is its best chunk's cosine
  similarity to the query, rescaled. Its keyword score is the coverage of
  query terms (title 1.0, body 0.6, last term as a prefix for
  search-as-you-type). `score = 0.6·semantic + 0.4·keyword`. Pages found
  by meaning alone must clear a minimum similarity. Until the model is
  ready, search is keyword-only and says so.
- **Related notes.** Pages are compared paragraph by paragraph: each chunk
  is matched with its nearest chunk on the other page, averaged both ways.
  The first version averaged each page into one vector, which ranked a
  packing list as equally close to "Garage" and to "Summer plans"; matching
  at chunk level fixed that.
- **Ctrl/Cmd-K** opens the palette, which blends both kinds of results and
  labels each one ("Similar meaning", "Matching words", "Words and
  meaning").
- **Automated browsers** don't download the model unless asked
  (`localStorage['tandem.semantic'] = 'on'`), so ordinary e2e tests stay
  hermetic.

### Version history (`packages/crdt/src/history.ts`)

- **A version is a prefix of the doc's op log.** The log is in causal
  order, so every prefix is a real past state, and `replay(ops, n)`
  rebuilds it. The slider steps through runs of edits by the same person,
  named via an `author:<agent>` entry each session writes into the root
  doc's map.
- **The diff needs no diff algorithm.** Fugue never reorders characters,
  and the current doc still holds every character ever typed (deleted ones
  as tombstones) in one final order. Walking it and asking of each id "was
  it visible then? is it visible now?" gives exact insert and delete
  segments.
- **Restore never rewrites history.** It applies that diff in reverse as
  new ops: delete what was added since, re-insert what was removed. It
  syncs like any edit, and edits made concurrently merge normally. A
  property test checks that two peers converge after a restore with
  concurrent edits, and the e2e test restores in one browser and checks
  the other.

### Lessons

- **Stale selections.** Every bug the end-to-end tests found was about one
  thing: the browser's DOM selection runs ahead of ProseMirror's state.
  ProseMirror only reads a click or an End/Ctrl+End key from the async
  `selectionchange` event. Anything that acts on `state.selection` in
  between writes the *stale* selection back, so text lands where the caret
  used to be, sometimes at the start of the document:
  - a remote transaction;
  - a presence redraw;
  - a key command (Enter) pressed right after End.

  The fix is the same each time: flush the DOM selection into the state
  first (`syncFromDom` before remote and presence dispatches, and
  `withDomSelection` around key commands). Remote carets moved to an
  overlay layer for a related reason: non-editable inline widgets broke
  the browser's own caret movement. Unit tests can't see this class of bug;
  only real-browser tests with two live contexts did.
- **Debounce needs a max wait.** A plain debounce never fires while a
  collaborator types continuously.

## Tests

| Suite | What it proves | Count |
|---|---|---|
| `packages/crdt` | Convergence under drops, duplicates, reordering and partitions (400 runs); idempotence and commutativity (300 + 300); no interleaving (500); **agreement with a paper-faithful FugueMax on every step (1,000)**; tree acyclicity and convergence (400); encoding round-trips; validation; cursor refs; **history: diff reassembles both versions, restore yields the past text with new ops only, restore converges across two peers with concurrent edits (200 runs each)** | 50 tests |
| `packages/sync` | Frame encoding, doc-id parsing, version-vector comparison | 4 tests |
| `apps/web` (unit) | Binding: offset ⇄ position round-trips (200 runs), random PM edits → CRDT text equal (300 runs), random remote patches → PM text equal (300 runs), PM → CRDT → CRDT → PM round trip, selection mapping cases; IndexedDB reload and snapshot compaction (fake-indexeddb). Search with a deterministic fake embedder: chunking, re-embedding only changed lines, reuse of persisted vectors, pruning, debounce and max wait, finding by meaning without shared words, keyword fallback, blended ranking, related notes | 26 tests |
| `apps/sync` (integration) | 3 real `SyncClient`s over WebSockets + Postgres, 250 random edits, one client offline then reconnecting; all replicas equal the server; a late joiner catches up; a *second server* loads the same text from Postgres. View-only tokens can't write (raw forged ops rejected). Bad tokens, foreign agents, garbage bytes and non-character references are rejected. Presence relay. Snapshot-on-load compaction | 5 tests |
| `apps/web` e2e (Playwright) | Two browser contexts: live text, cursors and selections both ways; one context goes offline, both keep writing, reconnect → converged (DOM equals CRDT on each side); offline reload restores from IndexedDB via the service worker. A view link is read-only. Dragging a page into its own subpage is refused with a toast. History: browse, diff, restore in one browser, converged in the other, old versions still there. Search: keyword results and the privacy note without the model; **with the real model in the browser**: a query with no shared words finds the right page, related notes, then offline reload and search by meaning still works (skipped when `CI` is set because it downloads the model) | 6 tests |

## Not done yet

- **No accounts.** Access is by capability links only, and tokens can't be
  revoked (that would need a per-workspace key version).
- **Op logs are not encrypted at rest.** The spec's end-to-end-encrypted
  log is still open; the server currently needs plaintext ops to validate
  and snapshot them.
- **No garbage collection** of tombstones or old history, on the client or
  the server.
- **Inline formatting** (Peritext-style marks; see above) and code blocks
  are not implemented.
- **Page order** among siblings is creation order (time-sortable ids), with
  no manual reordering. Drag-to-reparent uses HTML5 drag and drop, which
  doesn't work on touch screens. The trash has no restore UI yet.
- **Server rooms live in one process.** Horizontal scaling would need
  sticky routing by document or a shared pub/sub.
- **Search.** Indexing runs on the main thread's schedule, but embedding is
  in a worker. Very large notebooks would want the vectors in a typed
  array index rather than a `Map`. Titles of pages in the trash are not
  searchable, by design.
- **History** is per page body. Title and tree changes aren't on the
  timeline. Steps have no wall-clock times (ops don't carry them) and are
  labelled by version number and author.
- **Deployment** (milestone 5) is not done.
