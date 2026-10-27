# Tandem: Spec (v1)

> A local-first collaborative notes app. It works offline, syncs in real time, and its AI runs on your device.

## Why it's interesting
Most collaborative apps are a thin client over a server database. Tandem's source of truth is the **local device**: edits apply instantly, survive offline, and merge without conflicts when peers reconnect. That merging uses a **CRDT implemented from scratch**, not a library, which is the core engineering story.

## Features
- Rich-text notes (headings, lists, checkboxes, code blocks), nested pages, live cursors and presence
- Fully usable offline (PWA), with sync on reconnect; shareable links with view/edit permissions
- **On-device AI:** semantic search across your notes and "related notes" using in-browser embeddings (transformers.js / WebGPU). The AI never sends note content to a server unless the user opts into cloud summarization.
- Version history: browse and restore any past state (CRDTs make this nearly free)

## Engineering
- **CRDT:** a sequence CRDT for text (Fugue or RGA with interleaving fixes), a map/LWW-register for metadata, and tree moves for page hierarchy, all in TypeScript with formal properties tested via **property-based testing** (fast-check): convergence, commutativity, idempotence under random op orderings and network partitions
- Compact binary encoding + run-length compression of ops, with benchmarks against the Yjs/Automerge benchmark suite (`B1–B4` editing traces)
- **Sync:** WebSocket relay server (Node or Go) that stores encrypted op logs, version-vector based catch-up, and an IndexedDB local store
- Network-partition simulator in tests: N simulated peers with random delays, drops, and reconnects

## Stack
TypeScript CRDT core (standalone package), React + TipTap/ProseMirror bound to the CRDT, sync server (Node + ws) on Fly.io, Postgres for op-log persistence, Vercel for the app.

## Milestones
1. CRDT core + property tests + benchmarks
2. Editor binding + local persistence + offline
3. Sync server + presence + multi-peer tests
4. On-device semantic search
5. Version history, sharing, deploy, README with benchmarks, write-up ("Building a CRDT from scratch")
