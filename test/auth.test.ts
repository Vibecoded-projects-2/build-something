import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import type { Db } from "../server/db.ts";
import { testDb } from "./helpers.ts";

const password = "correct-horse-battery-staple";
const config = parseConfig({ ADMIN_PASSWORD: password, TARGET_ACCOUNT: "acme" });

describe("administrator session", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await testDb();
    app = await createApp({ config, db });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const login = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password },
    });
    const cookie = response.cookies.find((item) => item.name === "reviewgate_session");
    return { response, cookie, csrfToken: response.json().csrfToken as string };
  };

  it("reports health without a session and disables caching", async () => {
    const response = await app.inject({ url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects wrong credentials without creating a session", async () => {
    for (const payload of [
      { username: "admin", password: "wrong-password" },
      { username: "other", password },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/login", payload });
      expect(response.statusCode).toBe(401);
      expect(response.cookies).toHaveLength(0);
    }
    const rows = await db.query("SELECT count(*)::int AS count FROM sessions");
    expect(rows[0]?.count).toBe(0);
  });

  it("sets a strict HttpOnly cookie and stores only a token hash", async () => {
    const { response, cookie } = await login();
    expect(response.statusCode).toBe(200);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });

    const rows = await db.query("SELECT token_hash FROM sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(cookie?.value);
  });

  it("returns session details only to the signed-in client", async () => {
    const anonymous = await app.inject({ url: "/api/session" });
    expect(anonymous.json()).toEqual({ authenticated: false });

    const { cookie, csrfToken } = await login();
    const signedIn = await app.inject({
      url: "/api/session",
      cookies: { reviewgate_session: cookie!.value },
    });
    expect(signedIn.json()).toEqual({ authenticated: true, username: "admin", csrfToken });
  });

  it("requires a CSRF token and a matching origin for mutations", async () => {
    const { cookie, csrfToken } = await login();
    const cookies = { reviewgate_session: cookie!.value };

    const noToken = await app.inject({ method: "POST", url: "/api/logout", cookies });
    expect(noToken.statusCode).toBe(403);

    const wrongToken = await app.inject({
      method: "POST",
      url: "/api/logout",
      cookies,
      headers: { "x-csrf-token": "wrong" },
    });
    expect(wrongToken.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/logout",
      cookies,
      headers: { "x-csrf-token": csrfToken, origin: "https://attacker.example" },
    });
    expect(wrongOrigin.statusCode).toBe(403);
  });

  it("invalidates the session on logout", async () => {
    const { cookie, csrfToken } = await login();
    const cookies = { reviewgate_session: cookie!.value };

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      cookies,
      headers: { "x-csrf-token": csrfToken, origin: config.appOrigin },
    });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({ url: "/api/session", cookies });
    expect(after.json()).toEqual({ authenticated: false });
  });

  it("ignores expired sessions", async () => {
    const { cookie } = await login();
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    const response = await app.inject({
      url: "/api/session",
      cookies: { reviewgate_session: cookie!.value },
    });
    expect(response.json()).toEqual({ authenticated: false });
  });

  it("limits login attempts per minute", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "admin", password: "wrong-password" },
      });
    for (let index = 0; index < 5; index += 1) {
      expect((await attempt()).statusCode).toBe(401);
    }
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ ok: false, error: "RATE_LIMITED" });
  });
});
