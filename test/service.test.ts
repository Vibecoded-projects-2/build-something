import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../server/config.ts";
import type { Db } from "../server/db.ts";
import { PROMPT_VERSION } from "../server/domain.ts";
import {
  enqueuePeriodicSync,
  processWebhook,
  syncInventory,
  syncWorkspace,
  type ServiceDeps,
} from "../server/service.ts";
import type { NormalizedWebhook } from "../server/webhooks.ts";
import { FakeGitHub } from "./fake-github.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const config = parseConfig({
  ADMIN_PASSWORD: "correct-horse-battery-staple",
  TARGET_ACCOUNT: WORKSPACE,
});

const repository = { id: 10, fullName: "acme/app", private: true, archived: false };

const webhook = (overrides: Partial<NormalizedWebhook>): NormalizedWebhook => ({
  event: "pull_request",
  action: "opened",
  installationId: 7,
  repository,
  prNumber: 1,
  threadCommentIds: [],
  ...overrides,
});

describe("reconciliation and scheduling", () => {
  let db: Db;
  let github: FakeGitHub;
  let deps: ServiceDeps;

  beforeEach(async () => {
    db = await testDb();
    github = new FakeGitHub();
    deps = { config, db, github };
  });

  afterEach(async () => {
    await db.close();
  });

  const runs = () => db.query(`SELECT head_sha, base_sha, state, prompt_version FROM review_runs ORDER BY created_at`);
  const repo = async () => (await db.query(`SELECT * FROM repositories WHERE id = 10`))[0];

  it("requires GitHub App credentials", async () => {
    await expect(syncWorkspace({ config, db, github: null })).rejects.toThrow("GITHUB_APP_NOT_CONFIGURED");
  });

  it("keeps only installations owned by the target account", async () => {
    github.installations.push({ id: 8, accountId: 2, accountLogin: "other", repositorySelection: "all" });
    await syncInventory(deps);
    const rows = await db.query(`SELECT id FROM installations`);
    expect(rows.map((row) => Number(row.id))).toEqual([7]);
  });

  it("marks an installation inactive when it stops being listed", async () => {
    await syncInventory(deps);
    github.installations = [];
    await syncInventory(deps);
    expect((await db.query(`SELECT active FROM installations`))[0]?.active).toBe(false);
  });

  it("rejects a repository outside the target account", async () => {
    github.repositories.set(7, [{ id: 99, fullName: "other/app", private: false, archived: false }]);
    await expect(syncInventory(deps)).rejects.toThrow("REPOSITORY_ACCOUNT_MISMATCH");
  });

  it("preserves the monitoring toggle across syncs", async () => {
    await syncInventory(deps);
    await db.query(`UPDATE repositories SET enabled = false`);
    await syncInventory(deps);
    expect((await repo())?.enabled).toBe(false);
  });

  it("marks a repository inaccessible when access is removed", async () => {
    await syncInventory(deps);
    github.repositories.set(7, []);
    await syncInventory(deps);
    expect((await repo())?.accessible).toBe(false);
  });

  it("schedules one run per commit pair, including drafts", async () => {
    github.addPullRequest({ draft: true });
    await syncWorkspace(deps);
    await syncWorkspace(deps);
    expect(await runs()).toEqual([
      {
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        state: "queued",
        prompt_version: PROMPT_VERSION,
      },
    ]);
    const jobs = await db.query(`SELECT kind FROM jobs`);
    expect(jobs).toEqual([{ kind: "review" }]);
  });

  it("skips paused and archived repositories", async () => {
    github.addPullRequest();
    await syncInventory(deps);
    await db.query(`UPDATE repositories SET enabled = false`);
    await syncWorkspace(deps);
    expect(await runs()).toHaveLength(0);

    await db.query(`UPDATE repositories SET enabled = true`);
    github.repositories.set(7, [{ ...repository, archived: true }]);
    await syncWorkspace(deps);
    expect(await runs()).toHaveLength(0);
  });

  it("refreshes known PRs that left the open list", async () => {
    const pr = github.addPullRequest();
    await syncWorkspace(deps);
    pr.state = "closed";
    await syncWorkspace(deps);
    const rows = await db.query(`SELECT state FROM pull_requests`);
    expect(rows).toEqual([{ state: "closed" }]);
  });

  it("continues past a repository that has become unreachable", async () => {
    github.repositories.set(7, [
      repository,
      { id: 11, fullName: "acme/other", private: false, archived: false },
    ]);
    github.addPullRequest();
    const original = github.listOpenPullRequests.bind(github);
    github.listOpenPullRequests = async (ref) => {
      if (ref.repo === "app") {
        const { SafeError } = await import("../server/domain.ts");
        throw new SafeError("GITHUB_NOT_FOUND");
      }
      return original(ref);
    };
    await syncWorkspace(deps);
    expect((await repo())?.accessible).toBe(false);
    expect((await db.query(`SELECT accessible FROM repositories WHERE id = 11`))[0]?.accessible).toBe(true);
  });

  it("schedules a review when a PR is opened on an unknown repository", async () => {
    github.addPullRequest();
    await processWebhook(deps, webhook({}));
    expect(await runs()).toHaveLength(1);
  });

  it("uses the current PR state rather than trusting the delivery", async () => {
    const pr = github.addPullRequest();
    await processWebhook(deps, webhook({}));
    pr.headSha = "c".repeat(40);
    await processWebhook(deps, webhook({ action: "synchronize" }));
    expect((await runs()).map((run) => run.head_sha)).toEqual(["a".repeat(40), "c".repeat(40)]);
  });

  it("creates a new run for a base-only commit change", async () => {
    const pr = github.addPullRequest();
    await processWebhook(deps, webhook({}));
    pr.baseSha = "d".repeat(40);
    await processWebhook(deps, webhook({ action: "edited" }));
    expect((await runs()).map((run) => run.base_sha)).toEqual(["b".repeat(40), "d".repeat(40)]);
  });

  it("does not review an edit with the same commit pair twice", async () => {
    github.addPullRequest();
    await processWebhook(deps, webhook({}));
    await processWebhook(deps, webhook({ action: "edited" }));
    expect(await runs()).toHaveLength(1);
  });

  it("refreshes a closed PR without scheduling review", async () => {
    github.addPullRequest();
    await processWebhook(deps, webhook({}));
    github.pullRequests[0]!.state = "closed";
    github.pullRequests[0]!.headSha = "e".repeat(40);
    await processWebhook(deps, webhook({ action: "closed" }));
    expect(await runs()).toHaveLength(1);
    expect((await db.query(`SELECT state FROM pull_requests`))[0]?.state).toBe("closed");
  });

  it("updates repository state from repository events", async () => {
    await syncInventory(deps);
    await processWebhook(deps, webhook({
      event: "repository",
      action: "archived",
      repository: { ...repository, archived: true },
    }));
    expect((await repo())?.archived).toBe(true);

    await processWebhook(deps, webhook({ event: "repository", action: "deleted" }));
    expect((await repo())?.accessible).toBe(false);
  });

  it("deactivates an installation when it is removed", async () => {
    await syncInventory(deps);
    await processWebhook(deps, webhook({ event: "installation", action: "deleted", repository: null }));
    expect((await db.query(`SELECT active FROM installations`))[0]?.active).toBe(false);
  });

  it("queues a sync when installation repositories change", async () => {
    await processWebhook(deps, webhook({ event: "installation_repositories", action: "added" }));
    expect(await db.query(`SELECT kind FROM jobs`)).toEqual([{ kind: "sync" }]);
  });

  it("buckets periodic syncs", async () => {
    await enqueuePeriodicSync(deps, 0);
    await enqueuePeriodicSync(deps, 1000);
    await enqueuePeriodicSync(deps, 5 * 60 * 1000);
    expect(await db.query(`SELECT kind FROM jobs`)).toHaveLength(2);
  });
});
