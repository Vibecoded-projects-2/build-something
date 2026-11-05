import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SCHEMA_SQL } from "./schema.ts";

export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATION_LOCK_KEY = 7_204_118;

class PgliteDb implements Db {
  constructor(private readonly client: PGlite) {}

  async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query<T>(sql, params as any[]);
    return result.rows;
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) =>
      work({
        async query<R extends Row>(sql: string, params: unknown[] = []) {
          const result = await tx.query<R>(sql, params as any[]);
          return result.rows;
        },
      }),
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params as any[]);
    return result.rows;
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work({
        async query<R extends Row>(sql: string, params: unknown[] = []) {
          const result = await client.query<R>(sql, params as any[]);
          return result.rows;
        },
      });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface DbOptions {
  databaseUrl?: string;
  databaseCaFile?: string;
  /** Embedded data directory. Omit for an in-memory database. */
  pglitePath?: string;
}

export async function createDb(options: DbOptions): Promise<Db> {
  if (options.databaseUrl) {
    const ssl = options.databaseCaFile
      ? { ca: readFileSync(options.databaseCaFile, "utf8"), rejectUnauthorized: true }
      : undefined;
    return new PostgresDb(new pg.Pool({ connectionString: options.databaseUrl, ssl, max: 10 }));
  }
  if (options.pglitePath) mkdirSync(options.pglitePath, { recursive: true });
  const client = new PGlite(options.pglitePath);
  await client.waitReady;
  return new PgliteDb(client);
}

/** Applies the schema and creates the workspace row for the target account. */
export async function migrate(db: Db, targetAccount: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    for (const statement of splitStatements(SCHEMA_SQL)) {
      await tx.query(statement);
    }
    await tx.query(
      `INSERT INTO workspaces (id, account_login) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [targetAccount],
    );
  });
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export async function recordAudit(
  db: Queryable,
  workspaceId: string,
  action: string,
  objectId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, workspace_id, action, object_id) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), workspaceId, action, objectId ?? null],
  );
}
