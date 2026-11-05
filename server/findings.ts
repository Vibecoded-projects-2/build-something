import { z } from "zod";
import { recordAudit, type Db } from "./db.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const MIN_EVIDENCE_LENGTH = 5;

/** Outcomes a person may set. The model only ever sets the assessment outcomes. */
const HUMAN_OUTCOMES = ["open", "confirmed_fixed", "dismissed"] as const;

export const findingUpdateSchema = z
  .object({
    outcome: z.enum(HUMAN_OUTCOMES).optional(),
    evidence: z.string().trim().min(1).max(1500).optional(),
    fixSha: z.string().optional(),
    helpful: z.boolean().nullable().optional(),
  })
  .strict();

export type FindingUpdate = z.infer<typeof findingUpdateSchema>;

export type UpdateResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" | "EVIDENCE_REQUIRED" | "INVALID_FIX_SHA" | "UNKNOWN_FIX_COMMIT" };

/**
 * Applies a human decision. A confirmed fix needs evidence, a full commit SHA, and an
 * existing review-run record for that commit. Helpfulness is stored independently of
 * fix status, and only published findings can be changed.
 */
export async function updateFinding(
  db: Db,
  workspaceId: string,
  findingId: string,
  update: FindingUpdate,
): Promise<UpdateResult> {
  const [finding] = await db.query(
    `SELECT id, pr_id FROM findings
     WHERE id = $1 AND workspace_id = $2 AND github_comment_id IS NOT NULL`,
    [findingId, workspaceId],
  );
  if (!finding) return { ok: false, error: "NOT_FOUND" };

  if (update.outcome === "confirmed_fixed") {
    if (!update.evidence || update.evidence.length < MIN_EVIDENCE_LENGTH) {
      return { ok: false, error: "EVIDENCE_REQUIRED" };
    }
    if (!update.fixSha || !FULL_SHA.test(update.fixSha)) {
      return { ok: false, error: "INVALID_FIX_SHA" };
    }
    const runs = await db.query(`SELECT id FROM review_runs WHERE pr_id = $1 AND head_sha = $2 LIMIT 1`, [
      finding.pr_id,
      update.fixSha,
    ]);
    if (runs.length === 0) return { ok: false, error: "UNKNOWN_FIX_COMMIT" };
  }

  await db.transaction(async (tx) => {
    if (update.outcome === "confirmed_fixed") {
      await tx.query(
        `UPDATE findings
         SET outcome = 'confirmed_fixed', assessment = $2, fix_sha = $3, fixed_at = now()
         WHERE id = $1`,
        [findingId, update.evidence, update.fixSha],
      );
    } else if (update.outcome) {
      await tx.query(
        `UPDATE findings
         SET outcome = $2, assessment = COALESCE($3, assessment), fix_sha = NULL, fixed_at = NULL
         WHERE id = $1`,
        [findingId, update.outcome, update.evidence ?? null],
      );
    }
    if (update.helpful !== undefined) {
      await tx.query(`UPDATE findings SET helpful = $2 WHERE id = $1`, [findingId, update.helpful]);
    }
    await recordAudit(tx, workspaceId, "finding.updated", findingId);
  });

  return { ok: true };
}
