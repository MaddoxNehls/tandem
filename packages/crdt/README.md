# @tandem/crdt

The CRDT core of **Tandem**, a local-first collaborative notes app. Every
algorithm here is implemented from scratch in TypeScript with no runtime
dependencies. Yjs and Automerge are devDependencies, used only for the
benchmark comparison.

One `Doc` is one replica of a note. It contains:

| Part | CRDT | Used for |
|---|---|---|
| Text | **Fugue family** (YjsMod integration, conjectured equivalent to FugueMax; non-interleaving property-tested), run-length encoded, B-tree indexed | the note body |
| Map | **LWW register per key** (Lamport timestamp + agent-id tiebreak) | note metadata: title, icon, tags |
| Tree | **Movable tree** (Kleppmann et al. 2021; undo/do/redo over a move log) | page hierarchy |

All three share one Lamport clock, one op log, one version vector and one sync
protocol (`getOps(version)` / `applyRemote(ops)`), plus a compact binary encoding.

```ts
import { Doc, encodeOps, decodeOps } from '@tandem/crdt';

const alice = new Doc({ agent: 'alice-laptop' });
const bob = new Doc({ agent: 'bob-phone' });

alice.insert(0, 'Shopping:\n');
bob.applyRemote(alice.getOps());

alice.insert(10, 'milk\n');        // concurrent edits at the same position
bob.insert(10, 'eggs\n');
alice.setMeta('title', 'Groceries');
bob.movePage('groceries', 'root');

// Sync both ways: each side sends what the other's version vector lacks.
const toBob = encodeOps(alice.getOps(bob.version()));
const toAlice = encodeOps(bob.getOps(alice.version()));
bob.applyRemote(decodeOps(toBob));
alice.applyRemote(decodeOps(toAlice));

alice.text === bob.text;           // true: 'Shopping:\nmilk\neggs\n' (or eggs first, the same on both)
```

## API

```ts
class Doc {
  constructor(options?: { agent?: string })        // agent: globally unique replica id
  readonly agent: string

  // Text (positions are UTF-16 code units, like JS strings)
  get text(): string
  get length(): number
  insert(pos: number, text: string): void
  delete(pos: number, len: number): void

  // Metadata (LWW map)
  setMeta(key: string, value: JsonValue | undefined): void   // undefined deletes
  getMeta(key: string): JsonValue | undefined
  meta(): Record<string, JsonValue>

  // Page tree (ROOT = 'root', TRASH = 'trash')
  movePage(node: string, parent?: string): boolean  // also creates; false if it would make a cycle
  deletePage(node: string): void                    // moves the subtree to TRASH
  pageParent(node: string): string | undefined
  pageChildren(parent?: string): string[]
  isPageLive(node: string): boolean
  pages(): [node: string, parent: string][]

  // Sync
  version(): VersionVector                          // { [agent]: number of seqs seen }
  getOps(since?: VersionVector): Op[]               // what a peer at `since` is missing, causal order
  applyRemote(ops: readonly Op[]): ApplyResult      // any order, duplicates OK; buffers ops until deps arrive;
                                                    // throws InvalidOpError on malformed input (see below)
  get pending(): number                             // ops buffered waiting for dependencies

  // Stable cursors (for presence): survive concurrent edits
  cursorAt(pos: number): CursorRef                  // id of the char left of pos, or null at the start
  resolveCursor(ref: CursorRef): number | null      // current position; null if that char hasn't arrived yet

  // Persistence
  save(): Uint8Array                                // full snapshot (complete history)
  static load(bytes: Uint8Array, options?): Doc

  // Events
  on('change', (e: ChangeEvent) => void): () => void
}

encodeOps(ops: Op[], { snapshot? }): Uint8Array      // binary sync message
decodeOps(bytes: Uint8Array): Op[]
validateOp(op: unknown): string | null              // structural check for untrusted input (LIMITS)

// Version history (src/history.ts): a version is a prefix of getOps()
replay(ops: Op[], count?: number): Doc               // the document after the first `count` ops
diffSince(past: Doc, current: Doc): DiffSegment[]   // 'same' | 'inserted' | 'deleted', from tombstone order, no diff algorithm
restore(doc: Doc, past: Doc): { deleted, inserted } // reach past's text with NEW ops (history is never rewritten)

interface ChangeEvent {
  origin: 'local' | 'remote'
  ops: Op[]
  text: TextPatch[]        // { type: 'insert', pos, text } | { type: 'delete', pos, len }, apply in order
  meta: string[]           // keys whose value changed
  tree: boolean            // page tree may have changed
}
```

`TextPatch`es are what the editor binding (milestone 2) will turn into
ProseMirror transactions: positions are in visible characters and each patch
is relative to the text after the previous one.

---

## 1. Text: why Fugue

### The interleaving anomaly

Two people type at the same spot while offline:

```
base:        "Shopping:\n|"
Alice types:              "milk\n"
Bob types:                "eggs\n"
```

Any sequence CRDT converges (both replicas end up with the same string), but
*which* string matters. Several published algorithms can produce

```
"Shopping:\nmeiglgks\n\n"        <- interleaved character by character
```

Both runs survive, but the result is garbage that a human has to untangle by
hand. Kleppmann et al. ("Interleaving anomalies in collaborative text
editors", PaPoC 2019) showed that Logoot and LSEQ interleave runs typed
forwards, and that **RGA interleaves runs typed backwards** (each character
inserted before the previous one, e.g. typing with the cursor moved left after
each key, or some IME and autocomplete flows):

```
RGA, both users typing backwards at the same position:

Alice inserts c, then b before it, then a before that   -> "abc"
Bob   inserts z, then y before it, then x before that   -> "xyz"

RGA orders siblings of the same left neighbour by timestamp, newest first,
so each new char competes with the other user's chars:   "axbycz"
```

Weidner and Kleppmann ("The Art of the Fugue: Minimizing Interleaving in
Collaborative Text Editing", arXiv:2305.00583; v1 in 2023 also listed Joseph
Gentle as an author) define **maximal non-interleaving** and give two
algorithms. **Fugue** is proven forward non-interleaving, and **FugueMax**, a
small variant, is proven maximally non-interleaving: concurrent runs inserted
at the same place are never interleaved, whether typed forwards or backwards,
except in situations where the paper shows any algorithm must interleave.
Tandem wants that guarantee for a notes app where offline edits are the normal
case, which is why it targets FugueMax rather than RGA.

### How the algorithm works

Every character ever inserted is an item with a unique id `(agent, seq)`. An
agent's seqs are dense: 0, 1, 2, ... Deleted items stay as tombstones (they
are needed as reference points). When a character is inserted locally it
records two **origins**:

```
visible text:      H  e  l  l  o
full list:         H  e  l  [x]  l  o          [x] = tombstone
                            ^ cursor after the first "l"

originLeft  = the visible char left of the cursor          -> "l" (#1)
originRight = the item right after originLeft in the FULL   -> [x] (tombstones count)
              list, i.e. what the inserter saw next to it
```

On a remote replica, the new item goes somewhere between its origins. If
nothing else is between them, that is the only choice. If other items are
there, they were inserted concurrently (the inserter never saw them), and
`integrate` scans them to pick a deterministic position:

```
for each item `o` between originLeft (L) and originRight (R), left to right:
  oL, oR = positions of o's own origins
  if oL < L:                 stop, insert before o        (o belongs further left)
  if oL == L:
    if oR <  R:  tentatively skip o (keep scanning)       (o is a child of a later sibling)
    if oR == R:  sibling conflict: lower agent id goes first
    if oR >  R:  skip o
  if oL > L:                 skip o                       (o is nested inside an earlier item)
```

This list-based integration is Gentle's "YjsMod" algorithm (from
`josephg/reference-crdts`). It is *not proven* equivalent to FugueMax. The
paper only conjectures it (section 3.1, and again in section 8):

> "We conjecture that Sync9 is semantically equivalent to Fugue, while YjsMod
> is semantically equivalent to FugueMax. If that is indeed the case, then
> Sync9 and YjsMod satisfy forward and backward non-interleaving."

FugueMax itself borrows YjsMod's key idea (section 5.3): *"We learned of this
reverse-right-origin technique from Gentle's YjsMod."* That technique orders
right-side siblings by the reverse list order of their right origins.

Tandem therefore tests the conjecture for its own implementation instead of
assuming it. `test/fuguemax-oracle.ts` is a naive, paper-faithful FugueMax
(Algorithm 1 plus Definition 6, an explicit tree, one node per character).
`test/fuguemax.differential.test.ts` runs the same random multi-replica
editing and syncing script on both. After **every step** of 1,000 random runs,
the visible character ids are identical on every replica. As a control,
swapping the oracle to plain Fugue (right siblings ordered by id only) makes
the test fail within about 30 runs, so it does tell the two algorithms apart.
The paper's Figure 7/8 execution, the case where Fugue and FugueMax differ,
is also a unit test, and it produces the order the paper requires: `AXYBC`.
This is strong evidence, not a proof.

Why backwards typing does not interleave here, step by step:

```
base "[]".  Alice types a,b,c backwards; Bob types x,y,z backwards.
Alice's chars:  c (oL='[', oR=']')   b (oL='[', oR=c)   a (oL='[', oR=b)
Bob's chars:    z (oL='[', oR=']')   y (oL='[', oR=z)   x (oL='[', oR=y)

On Alice's replica: [ a b c ]       integrate Bob's z (L='[', R=']'):
  a: oL==L, oR=b <  R  -> tentatively skip (a hangs off b)
  b: oL==L, oR=c <  R  -> tentatively skip
  c: oL==L, oR==R      -> sibling of z: 'alice' < 'bob', so z goes after c
  => [ a b c z ]
then y (R=z) and x (R=y) land directly before z, so: [ a b c x y z ]
Bob's replica computes the same thing from the other side.
```

### Representation: runs, spans and a B-tree

Storing one object per character is slow and memory-hungry. Characters typed
consecutively by one agent form a **span**:

```
Span { agent, seq, len, content, deleted,
       originLeft  of the first char,
       originRight shared by all chars }

"hello" typed forwards = ONE span:
   h(seq 0, oL=start)  e(1, oL=h)  l(2, oL=e)  l(3, oL=l)  o(4, oL=l)
   only h's originLeft is stored; char k's is implicitly (agent, seq+k-1)
```

Spans are split when an edit lands inside them and adjacent tombstones of the
same run are merged back together. Typing at the end of a span, the common
case, just appends to its `content`.

Spans live in the leaves of a **B-tree** (fan-out 64). Every node caches two
counts for its subtree: `raw` (items including tombstones) and `vis` (visible
characters):

```
                       [raw 182315 | vis 104852]
                      /            |             \
          [raw 61k | vis 35k]  [raw 60k | vis 34k]  [ ... ]       internal nodes
           /   |   \
     [leaf: span span span ... (up to 64)]  ->  [leaf] -> [leaf]  linked leaves
```

* *visible position -> span*: descend by `vis` counts, O(B log_B n).
* *span -> position*: walk up via parent pointers summing left siblings.
* *id -> span*: `runs[agent]` holds one entry per insert run, sorted by seq
  (append-only, because an agent's seqs only grow), each with its current
  fragments sorted by seq. Two binary searches, O(log n).

### Complexity

`n` = number of spans (12,502 for the 259,778-edit trace), `B` = 64.

| Operation | Cost |
|---|---|
| local insert / delete | O(B log_B n), plus an O(f) array splice when a run with f fragments is split |
| remote insert, no concurrency at that position | O(B log_B n) |
| remote insert with c concurrent items between its origins | O(c · B log_B n) |
| remote delete | O(B log_B n) per affected fragment |
| `text` | O(n) |
| `getOps(version)` | O(L), L = number of log entries |
| map set / get | O(1) |
| tree move | O(1 + k·d) where k = logged moves with a later timestamp (undone and redone), d = depth |

Memory is O(spans + log entries). Tombstones and the op log are retained
(see "Limitations").

## 2. Map: LWW registers

Each key is a last-writer-wins register. A write carries `(lamport, agent)`
and replaces the current value iff that pair is greater
(`l1 > l2 || (l1 == l2 && a1 > a2)`). Lamport clocks guarantee that a write
made after seeing another write has a bigger timestamp, so causally later
writes always win, and concurrent writes are resolved the same way
everywhere. Deleting is writing a tombstone (`undefined`), ordered by the
same rule. "Take the maximum" is commutative, associative and idempotent,
hence convergence.

## 3. Tree: moves without cycles

Kleppmann, Mulligan, Gomes and Beresford, "A highly-available move operation
for replicated trees" (IEEE TPDS 2021). The only operation is
`move(timestamp, node, newParent)`. Creating a page is moving a new node;
deleting is moving it under `TRASH` (so it can be restored).

The danger is concurrent moves forming a cycle:

```
start:   root ── A          replica 1: move A under B      root ── B ── A
             └── B          replica 2: move B under A      root ── A ── B
naive merge of both:  A under B and B under A  ->  A <-> B cycle, detached from root
```

The algorithm defines the result as "apply all moves one by one in
timestamp order, skipping any move whose new parent is the node itself or
one of its descendants". Moves arrive out of order, so each replica keeps a
log sorted by timestamp, with each entry storing the node's *previous*
parent:

```
apply move m:
  1. UNDO   pop every log entry newer than m, restoring each node's old parent
  2. DO     apply m (or skip it if it would create a cycle); log it with the old parent
  3. REDO   re-apply the popped entries in timestamp order, re-checking each for cycles
```

Every replica therefore reaches the state of the same sequential execution,
and the tree is acyclic after every single step. In the example, both moves
have Lamport time 2; `r2 > r1`, so "B under A" is ordered second and skipped.

## 4. The document, causality and sync

```
          local edit                               remote ops (any order, dupes)
              │                                                 │
              ▼                                                 ▼
   ┌─────────────────────┐   ops    ┌──────────────────────────────────────────┐
   │ assign id (agent,   │ ───────▶ │ applyRemote                               │
   │ seq) + lamport      │          │  seq already seen?          -> ignore     │
   │ apply to text/map/  │          │  partly seen?               -> trim       │
   │ tree, append to log │          │  agent's previous seq or a                │
   │ (merge with last op │          │  referenced char missing?   -> buffer     │
   │  if it continues it)│          │  else apply, advance version, wake any    │
   └─────────────────────┘          │  buffered ops waiting on this agent       │
                                    └──────────────────────────────────────────┘
```

* **Ids and spans.** An op occupies `span` consecutive seqs and Lamport
  values: an insert of k chars uses k (one id per char), a delete of k chars
  uses k, map and tree ops use 1.
* **Version vectors.** Each agent's ops are applied in seq order, so
  `{agent: nextSeq}` exactly describes a replica's state. `getOps(v)` returns
  the log entries (or suffixes of them) beyond `v`, in the log's causal order.
* **Causal readiness.** An op is ready when its agent's previous seq has been
  applied and every char it references (insert origins, delete targets) exists.
  These are exactly the dependencies the CRDTs need, which is cheaper than
  shipping full vector-clock dependencies with every op.
* **Buffering.** A blocked op is filed under the agent it waits for, sorted by
  the seq it needs. When that agent advances, the ops that became ready are
  re-queued. Reversed delivery costs O(log w) per op rather than a full rescan.
* **Idempotence.** Already-applied ops are counted as duplicates and
  ignored. Partially applied ones (a peer merged ops differently) are trimmed
  to the unseen suffix.
* **Run-length op log.** Consecutive local ops that continue each other are
  merged: forward typing becomes one insert op, and a run of backspaces becomes
  one delete op with a *reversed* range (`rev: true`) so the op's units still
  map, in order, onto the characters it deleted. That order matters when a
  peer saw only the first few backspaces and needs the rest trimmed correctly.
  The 259,778-edit trace collapses to 10,160 ops.

## 5. Binary encoding

`encodeOps(ops)` produces sync messages, and `doc.save()` produces the full
snapshot (the complete history). Integers are LEB128 varints, and signed
values are zigzag-encoded.

```
┌──────┬─────┬───────┬──────────────┬───────────────┬─────────┬──────────┬───────────────────┐
│ "TD" │ ver │ flags │ agent table  │ string table  │ opCount │ ops ...  │ content blob      │
│ 2 B  │ 1 B │ 1 B   │ n, (len,str)*│ n, (len,str)* │ varint  │          │ len, UTF-8/WTF-8  │
└──────┴─────┴───────┴──────────────┴───────────────┴─────────┴──────────┴───────────────────┘

op header byte:
  bit  7   6   5   4             3             2            1 0
      [ kind flags ][lamport = ][seq = agent's][same agent ][kind ]
                     prev end    next seq       as prev op   ins/del/set/move

insert:  flags = oL is (agent, seq-1) | oL is doc start | oR is doc end
         [oL agentIdx, zigzag(oL.seq - seq)] [oR agentIdx, zigzag(oR.seq - seq)] contentLen
delete:  flag = all targets are the op's own agent
         count, then per range: [agentIdx] zigzag(seq - ref) (len*2 + rev)
set:     keyIdx, value tag (undefined | null | false | true | int | f64 | string | json), payload
move:    nodeIdx, parentIdx
```

Design choices:

* **Implicit fields.** In the common case (same agent, next seq, next Lamport
  value) the op id and timestamp take **zero bytes**: just three header bits.
* **Relative ids.** Origins and delete targets are encoded relative to the
  op's own seq, so the numbers stay small varints.
* **String tables.** Agent ids, map keys, string values and page ids are each
  written once and then referenced by index.
* **Content blob.** All inserted text is concatenated into a single UTF-8
  blob after the ops, so text stays contiguous and transport compression
  works well.
* **WTF-8 fallback.** Positions are UTF-16 code units, so a span can be split
  between the two halves of a surrogate pair. Plain UTF-8 cannot represent a
  lone surrogate. When one is present, the blob is written as WTF-8 and a
  flag bit is set.

For the trace, the result is **~1 byte per edit** (257,843 bytes for 259,778
edits, of which 182,315 bytes are the inserted text itself). A single
keystroke sent as its own sync message is 37 bytes, most of which is the
agent-id table.

## 6. Testing

`pnpm test` runs 50 tests: unit tests for the edge cases plus fast-check
property tests. The run counts are in the test names.

**Network simulator** (`test/helpers.ts`): N replicas (2-5). Messages are
batches of ops sent from a possibly stale view of the receiver, so they
contain duplicates. Ops are randomly dropped (0/30/70%), duplicated and
shuffled. Half of the messages go through the binary encoder. Delivery picks
any queued message, not FIFO. Random partitions split the replicas into two
groups that cannot talk until a heal. At the end everything is flushed and
anti-entropy runs.

| Property | Test |
|---|---|
| **Convergence**: all replicas identical (text, char ids, meta, tree, version) | `convergence.property` (400 runs, ~80 random steps each: inserts with arbitrary Unicode, deletes, backspace runs, meta writes, moves, sends, deliveries, partitions, heals) |
| **Local intention**: every local insert/delete equals the plain string splice | checked after every local edit in the simulation |
| **Order preservation**: two chars ever seen in some order keep that order | id snapshots taken mid-run, checked against the final list |
| **Map / tree = sequential reference** | the final meta equals "max timestamp per key", and the final tree equals "apply moves in timestamp order, skipping cycles" |
| **Idempotence** | re-applying all ops, reversed, plus random subsets: no change, all counted as duplicates (300 runs) |
| **Commutativity** | two random one-op-at-a-time delivery orders give identical states (300 runs) |
| **Agrees with FugueMax** | differential test against a paper-faithful tree implementation; identical char order after every step (1,000 runs) |
| **No interleaving (Fugue)** | 2-5 users concurrently type random runs at the same position, each forwards or backwards, delivered one op at a time in random order: every run is contiguous and in order (500 runs) |
| **Tree: no cycles, convergence** | random concurrent moves, acyclicity asserted after *every* op application on every replica (400 runs) |
| **Encoding round-trip** | random concurrent edits with arbitrary code points (200 runs); snapshots reload to identical char ids |
| **B-tree vs string model** | 500-3,000 random edits (60 runs), plus a 40,000-edit run that forces a depth-3 tree |

Mutation checks during development: making the conflict tiebreak use
replica-local agent indices, disabling the "tentatively skip" rule, or
trimming reversed delete ranges from the wrong end each make the property
tests fail within 1-2 runs.

## 7. Benchmarks

Results from `pnpm bench` (KB = 1024 bytes):

| Library | Apply trace | Throughput | Memory after GC | Encoded size | Bytes / edit | Save | Load |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tandem (this package) | 194 ms | 1,339k edits/s | 6.5 MB | 251.8 KB | 0.99 | 7.2 ms | 35.0 ms |
| Yjs 13.6 | 1,629 ms | 159k edits/s | 3.8 MB | 303.7 KB | 1.20 | 8.0 ms | 16.2 ms |
| Automerge 3.5, whole trace in 1 change | 6,850 ms | 38k edits/s | 103.9 MB | 126.1 KB | 0.50 | 10.1 ms | 153.2 ms |
| Automerge 3.5, 1 change per edit | 17,446 ms | 15k edits/s | 54.8 MB | 126.2 KB | 0.50 | 24.5 ms | 1,063.8 ms |

- Machine: AMD Ryzen 7 7800X3D 8-Core Processor, 16 threads, 31,888.0 MB RAM, win32 10.0.26200, Node v24.14.0.
- Trace: automerge-paper, 259,778 edits -> 10,160 run-length-merged Tandem ops, 12,502 spans, B-tree depth 3.
- Tandem remote apply: 259,778 unmerged ops through applyRemote in 242 ms (1,072k ops/s).
- One keystroke as a Tandem sync message: 37 bytes.
- Medians of 5 runs (Automerge per-edit: 1 run).
- Run-to-run variance on this desktop is large for the slower libraries: in earlier single runs Yjs took 1.1 s (236k edits/s) and Automerge per-edit took 33 s. Tandem's apply time stayed between 170 and 260 ms.

How it was measured (`pnpm bench`, source in `bench/`):

* **Trace**: `automerge-paper` from
  [josephg/editing-traces](https://github.com/josephg/editing-traces), the
  keystroke history of Martin Kleppmann writing a LaTeX paper (the trace
  behind automerge-perf and the crdt-benchmarks B4 test). 259,778 edits:
  182,315 characters inserted and 77,463 deleted, 104,852 left at the end.
  Each library applies every edit as a local edit and the final text is
  checked against the trace.
* **Memory** is `heapUsed + external` after forced GC, minus the baseline
  before the document was created. For Automerge, the WASM linear memory is
  part of `external`. WASM memory only grows, so that figure is a high-water
  mark and not directly comparable.
* **Encoded size** is `doc.save()` (Tandem; complete history),
  `Y.encodeStateAsUpdate` (Yjs; current state plus tombstone ids, deleted text
  discarded), and `Automerge.save` (complete history, columnar and compressed).
* **Load** means decoding those bytes into a new document and reading the text.
* Each library runs in a fresh Node process. Timings are medians.

Reading the results honestly:

* Tandem's local-edit throughput is the best of the three here. Part of that
  is scope: Tandem is a plain-text CRDT with a focused API, while Yjs carries
  general shared types, formatting attributes and per-transaction event
  machinery, and Automerge builds a hashed change object per commit. Yjs and
  Automerge are also far more battle-tested.
* Tandem uses more memory than Yjs because it keeps the full op log
  (history) in memory alongside the document state. Yjs keeps only the state
  and garbage-collects deleted content.
* Automerge's encoding is the most compact (columnar layout plus DEFLATE).
  Tandem's is ~2x larger, about 1 byte per edit, and smaller than Yjs's.
* Tandem's load replays the history through `applyRemote`, which is fast here
  because the log is RLE-merged (10,160 ops). Automerge with one change per
  edit has to rebuild 259,778 change records, which dominates its load time.

## 8. Limitations and next steps

* **No garbage collection.** Tombstones and the op log grow forever. The
  standard fix is to compact once ops are causally stable (seen by every
  peer). That needs the sync server's membership info (milestone 3).
* The **tree move log** is never truncated either. The same causal-stability
  cut-off applies.
* **Sibling order** in the page tree is by node id. User-defined ordering
  will come from a fractional index stored in each page's metadata.
* **Snapshots are full histories.** Loading replays them, which takes about
  30 ms for this trace. A state-only snapshot, with lazily loaded history for
  version browsing, would cut both load time and size.
* **Plain text only.** The editor (apps/web) expresses block structure as
  markdown-ish line prefixes. Inline marks (bold, links) are planned as a
  Peritext-style mark CRDT anchored to character ids.
* **Untrusted input** is validated in two stages. `validateOp` checks types,
  bounds (counters below 2^48, sizes) and self-references for the whole
  batch, and `applyRemote` rejects the batch before applying anything if any
  op fails. At apply time, an op whose referenced ids exist but are not
  characters (for example a delete aimed at a map op's id) throws
  `InvalidOpError` *before* it mutates anything. Earlier ops in the batch
  stay applied, since each op is atomic. Ops waiting on ids that never
  arrive stay buffered, so a server should cap `pending` (the sync server
  does).
* Only the automerge-paper trace (crdt-benchmarks B4) is benchmarked so far,
  not the full B1-B3 microbenchmark suite.

## References

* M. Weidner, M. Kleppmann. *The Art of the Fugue: Minimizing Interleaving
  in Collaborative Text Editing.* arXiv:2305.00583v3, 2025 (v1, 2023, with
  J. Gentle). Sections 3.1 and 8 (the YjsMod conjecture), 5.3 (FugueMax).
* M. Kleppmann, V. B. F. Gomes, D. P. Mulligan, A. R. Beresford.
  *Interleaving anomalies in collaborative text editors.* PaPoC 2019.
* M. Kleppmann, D. P. Mulligan, V. B. F. Gomes, A. R. Beresford. *A
  highly-available move operation for replicated trees.* IEEE TPDS 33(7), 2022.
* H.-G. Roh, M. Jeon, J.-S. Kim, J. Lee. *Replicated abstract data types:
  Building blocks for collaborative applications* (RGA). JPDC 71(3), 2011.
* P. Nicolaescu, K. Jahns, M. Derntl, R. Klamma. *Near Real-Time Peer-to-Peer
  Shared Editing on Extensible Data Types* (YATA / Yjs). GROUP 2016.
* L. Lamport. *Time, Clocks, and the Ordering of Events in a Distributed
  System.* CACM 21(7), 1978.
* M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski. *Conflict-free Replicated
  Data Types.* SSS 2011.
* J. Gentle. *reference-crdts* and *Diamond Types*; *editing-traces*
  (github.com/josephg).
