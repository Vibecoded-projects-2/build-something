import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, recordAudit, type Db } from "../server/db.ts";

describe("database", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({});
    await migrate(db, "acme");
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates the workspace for the target account", async () => {
    const rows = await db.query("SELECT id, account_login FROM workspaces");
    expect(rows).toEqual([{ id: "acme", account_login: "acme" }]);
  });

  it("can be applied repeatedly", async () => {
    await migrate(db, "acme");
    const rows = await db.query("SELECT count(*)::int AS count FROM workspaces");
    expect(rows[0]?.count).toBe(1);
  });

  it("rolls back a failed transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await recordAudit(tx, "acme", "test.action");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const rows = await db.query("SELECT count(*)::int AS count FROM audit_events");
    expect(rows[0]?.count).toBe(0);
  });

  it("keeps runs unique per head, base, and prompt version", async () => {
    await db.query(
      `INSERT INTO installations (id, workspace_id, account_id, account_login, repository_selection)
       VALUES (1, 'acme', 1, 'acme', 'all')`,
    );
    await db.query(
      `INSERT INTO repositories (id, workspace_id, installation_id, full_name) VALUES (2, 'acme', 1, 'acme/app')`,
    );
    await db.query(
      `INSERT INTO pull_requests (id, repo_id, workspace_id, number, title, author, url, state, head_sha, base_sha, opened_at)
       VALUES ('2:1', 2, 'acme', 1, 't', 'a', 'u', 'open', 'head', 'base', now())`,
    );
    const insert = (id: string, base: string) =>
      db.query(
        `INSERT INTO review_runs (id, pr_id, workspace_id, head_sha, base_sha, model, prompt_version)
         VALUES ($1, '2:1', 'acme', 'head', $2, 'model', 'v1')`,
        [id, base],
      );

    await insert("run-1", "base");
    await expect(insert("run-2", "base")).rejects.toThrow();
    await expect(insert("run-3", "other-base")).resolves.toBeDefined();
  });
});
