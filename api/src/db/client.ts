import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number | null };

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
  kind: 'pg' | 'pglite';
}

let dbPromise: Promise<Db> | null = null;

async function initPg(): Promise<Db> {
  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  await pool.query('SELECT 1');
  return {
    kind: 'pg',
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
    async end() {
      await pool.end();
    },
  };
}

async function initPglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(env.pgliteDir, { recursive: true });
  const client = new PGlite(env.pgliteDir);
  await client.waitReady;
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await client.exec(schema);
  return {
    kind: 'pglite',
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const res = await client.query(text, params as never[]);
      return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
    },
    async end() {
      await client.close();
    },
  };
}

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = env.usePglite ? initPglite() : initPg().catch(async (err) => {
      console.warn('[db] PostgreSQL unavailable, falling back to PGlite:', (err as Error).message);
      return initPglite();
    });
  }
  return dbPromise;
}

export async function ensureSchema(db: Db): Promise<void> {
  // Always re-apply IF NOT EXISTS statements so new tables land on existing DBs.
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  if (db.kind === 'pglite') {
    // PGlite prefers exec for multi-statement SQL
    const { PGlite } = await import('@electric-sql/pglite');
    void PGlite;
    // db.query may not accept multi-statement; split on semicolons carefully
    const parts = schema
      .split(/;\s*
/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('--'));
    for (const part of parts) {
      try {
        await db.query(part.endsWith(';') ? part : part + ';');
      } catch (e) {
        // ignore "already exists" style races; log others
        const msg = (e as Error).message || '';
        if (!/already exists|duplicate/i.test(msg)) {
          console.warn('[schema]', msg.slice(0, 160), '::', part.slice(0, 80));
        }
      }
    }
    return;
  }
  await db.query(schema);
}
