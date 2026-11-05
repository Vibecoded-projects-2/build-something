import { createDb, migrate, type Db } from "../server/db.ts";

export const WORKSPACE = "acme";

export async function testDb(): Promise<Db> {
  const db = await createDb({});
  await migrate(db, WORKSPACE);
  return db;
}
