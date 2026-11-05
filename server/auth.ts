import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { Queryable } from "./db.ts";

export const SESSION_COOKIE = "reviewgate_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface CredentialVerifier {
  verify(username: string, password: string): Promise<boolean>;
}

/** Hashes the configured password once so plaintext is not compared directly. */
export async function createCredentialVerifier(
  expectedUsername: string,
  expectedPassword: string,
): Promise<CredentialVerifier> {
  const passwordHash = await argon2.hash(expectedPassword, { type: argon2.argon2id });
  return {
    async verify(username, password) {
      // Always run the slow check so an unknown username takes the same time.
      const passwordMatches = await argon2.verify(passwordHash, password);
      return safeEqual(username, expectedUsername) && passwordMatches;
    },
  };
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Session {
  workspaceId: string;
  username: string;
  csrfToken: string;
}

export async function createSession(
  db: Queryable,
  workspaceId: string,
  username: string,
): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(
    `INSERT INTO sessions (token_hash, workspace_id, username, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [hashToken(token), workspaceId, username, csrfToken, SESSION_TTL_SECONDS],
  );
  return { token, csrfToken };
}

export async function findSession(db: Queryable, token: string): Promise<Session | null> {
  const rows = await db.query(
    `SELECT workspace_id, username, csrf_token FROM sessions
     WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return { workspaceId: row.workspace_id, username: row.username, csrfToken: row.csrf_token };
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}
