import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, migrate, type Db } from "../server/db.ts";

export const WORKSPACE = "acme";

/**
 * Uses in-memory PGlite by default. With TEST_DATABASE_URL set, each database is a
 * fresh schema on a real PostgreSQL server, so tests can run in parallel.
 */
export async function testDb(): Promise<Db> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (!serverUrl) {
    const db = await createDb({});
    await migrate(db, WORKSPACE);
    return db;
  }

  const schema = `test_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const url = new URL(serverUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = await createDb({ databaseUrl: url.toString() });
  await migrate(db, WORKSPACE);

  const close = db.close.bind(db);
  db.close = async () => {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await close();
  };
  return db;
}
