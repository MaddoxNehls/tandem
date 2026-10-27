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
