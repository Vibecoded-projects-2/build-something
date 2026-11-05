import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../server/db.ts";
import { findingUpdateSchema, updateFinding } from "../server/findings.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);

describe("human finding decisions", () => {
  let db: Db;

  beforeEach(async () => {
    db = await testDb();
    await db.query(
      `INSERT INTO installations (id, workspace_id, account_id, account_login, repository_selection)
       VALUES (1, $1, 1, 'acme', 'all')`,
      [WORKSPACE],
    );
    await db.query(
      `INSERT INTO repositories (id, workspace_id, installation_id, full_name) VALUES (2, $1, 1, 'acme/app')`,
      [WORKSPACE],
    );
    await db.query(
      `INSERT INTO pull_requests (id, repo_id, workspace_id, number, title, author, url, state, head_sha, base_sha, opened_at)
       VALUES ('2:1', 2, $1, 1, 't', 'a', 'u', 'open', $2, 'b', now())`,
      [WORKSPACE, HEAD],
    );
    await db.query(
      `INSERT INTO review_runs (id, pr_id, workspace_id, head_sha, base_sha, model, prompt_version)
       VALUES ('run-1', '2:1', $1, $2, 'b', 'm', 'v1')`,
      [WORKSPACE, HEAD],
    );
    const insert = (id: string, commentId: number | null) =>
      db.query(
        `INSERT INTO findings (id, workspace_id, pr_id, run_id, fingerprint, category, severity, title, body, path, line, evidence, suggestion, github_comment_id)
         VALUES ($1, $2, '2:1', 'run-1', $1, 'correctness', 'high', 't', 'b', 'p', 1, 'e', 's', $3)`,
        [id, WORKSPACE, commentId],
      );
    await insert("published", 500);
    await insert("draft", null);
  });

  afterEach(async () => {
    await db.close();
  });

  const finding = async (id = "published") =>
    (await db.query(`SELECT outcome, fix_sha, fixed_at, helpful, assessment FROM findings WHERE id = $1`, [id]))[0];

  const confirm = { outcome: "confirmed_fixed" as const, evidence: "Guard restored", fixSha: HEAD };

  it("confirms a fix with evidence and a reviewed commit", async () => {
    expect(await updateFinding(db, WORKSPACE, "published", confirm)).toEqual({ ok: true });
    expect(await finding()).toMatchObject({
      outcome: "confirmed_fixed",
      fix_sha: HEAD,
      assessment: "Guard restored",
    });
    expect((await finding())?.fixed_at).toBeInstanceOf(Date);
  });

  it.each([
    [{ ...confirm, evidence: undefined }, "EVIDENCE_REQUIRED"],
    [{ ...confirm, evidence: "abc" }, "EVIDENCE_REQUIRED"],
    [{ ...confirm, fixSha: undefined }, "INVALID_FIX_SHA"],
    [{ ...confirm, fixSha: "abc123" }, "INVALID_FIX_SHA"],
    [{ ...confirm, fixSha: HEAD.toUpperCase() }, "INVALID_FIX_SHA"],
    [{ ...confirm, fixSha: OTHER }, "UNKNOWN_FIX_COMMIT"],
  ])("rejects an unsupported confirmation %#", async (update, error) => {
    expect(await updateFinding(db, WORKSPACE, "published", update)).toEqual({ ok: false, error });
    expect((await finding())?.outcome).toBe("open");
  });

  it("does not expose unpublished findings or other workspaces", async () => {
    expect(await updateFinding(db, WORKSPACE, "draft", confirm)).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await updateFinding(db, "other", "published", confirm)).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("records a dismissal without marking anything fixed", async () => {
    await updateFinding(db, WORKSPACE, "published", { outcome: "dismissed", evidence: "Intended behavior" });
    expect(await finding()).toMatchObject({ outcome: "dismissed", fix_sha: null, fixed_at: null });
  });

  it("clears fix details when a finding is reopened", async () => {
    await updateFinding(db, WORKSPACE, "published", confirm);
    await updateFinding(db, WORKSPACE, "published", { outcome: "open" });
    expect(await finding()).toMatchObject({ outcome: "open", fix_sha: null, fixed_at: null });
  });

  it("stores helpfulness independently of fix status", async () => {
    await updateFinding(db, WORKSPACE, "published", { helpful: false });
    expect(await finding()).toMatchObject({ outcome: "open", helpful: false });
    await updateFinding(db, WORKSPACE, "published", { helpful: null });
    expect((await finding())?.helpful).toBeNull();
  });

  it("writes an audit event", async () => {
    await updateFinding(db, WORKSPACE, "published", { helpful: true });
    expect(await db.query(`SELECT action, object_id FROM audit_events`)).toEqual([
      { action: "finding.updated", object_id: "published" },
    ]);
  });

  it("does not accept model-only outcomes or unknown fields from people", () => {
    expect(findingUpdateSchema.safeParse({ outcome: "suspected_fixed" }).success).toBe(false);
    expect(findingUpdateSchema.safeParse({ github_comment_id: 1 }).success).toBe(false);
  });
});
