/**
 * Postgres persistence for document op logs.
 *
 *   doc_ops        append-only log: one row per batch of ops (encodeOps bytes)
 *   doc_snapshots  latest snapshot per doc + the last op row it includes
 *   workspaces     claimed workspace ids
 *
 * Writes are batched by the server (one row per flush, not per keystroke).
 * Loading a doc reads its snapshot plus the rows after it; when that tail
 * gets long, the server writes a fresh snapshot and drops the covered rows.
 */
import pg from 'pg';

export interface LoadedDoc {
  snapshot: Uint8Array | null;
  /** Op batches after the snapshot, in order. */
  rows: { id: number; ops: Uint8Array }[];
}

export interface Store {
  claimWorkspace(id: string): Promise<boolean>;
  loadDoc(docId: string): Promise<LoadedDoc>;
  appendOps(docId: string, ops: Uint8Array): Promise<number>;
  /** Store a snapshot covering all rows up to `upto` and delete those rows. */
  compact(docId: string, snapshot: Uint8Array, upto: number): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
create table if not exists workspaces (
  id text primary key,
  created_at timestamptz not null default now()
);
create table if not exists doc_ops (
  id bigserial primary key,
  doc_id text not null,
  ops bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists doc_ops_doc_id on doc_ops (doc_id, id);
create table if not exists doc_snapshots (
  doc_id text primary key,
  snapshot bytea not null,
  upto bigint not null,
  updated_at timestamptz not null default now()
);
`;

export class PgStore implements Store {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(SCHEMA);
    return new PgStore(pool);
  }

  async claimWorkspace(id: string): Promise<boolean> {
    const res = await this.pool.query('insert into workspaces (id) values ($1) on conflict do nothing', [id]);
    return res.rowCount === 1;
  }

  async loadDoc(docId: string): Promise<LoadedDoc> {
    const snap = await this.pool.query<{ snapshot: Buffer; upto: string }>(
      'select snapshot, upto from doc_snapshots where doc_id = $1',
      [docId],
    );
    const upto = snap.rows[0] ? Number(snap.rows[0].upto) : 0;
    const rows = await this.pool.query<{ id: string; ops: Buffer }>(
      'select id, ops from doc_ops where doc_id = $1 and id > $2 order by id',
      [docId, upto],
    );
    return {
      snapshot: snap.rows[0] ? new Uint8Array(snap.rows[0].snapshot) : null,
      rows: rows.rows.map((r) => ({ id: Number(r.id), ops: new Uint8Array(r.ops) })),
    };
  }

  async appendOps(docId: string, ops: Uint8Array): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      'insert into doc_ops (doc_id, ops) values ($1, $2) returning id',
      [docId, Buffer.from(ops)],
    );
    return Number(res.rows[0]!.id);
  }

  async compact(docId: string, snapshot: Uint8Array, upto: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into doc_snapshots (doc_id, snapshot, upto) values ($1, $2, $3)
         on conflict (doc_id) do update set snapshot = excluded.snapshot, upto = excluded.upto, updated_at = now()`,
        [docId, Buffer.from(snapshot), upto],
      );
      await client.query('delete from doc_ops where doc_id = $1 and id <= $2', [docId, upto]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
