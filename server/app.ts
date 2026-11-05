import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";
import {
  createCredentialVerifier,
  createSession,
  deleteSession,
  findSession,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Session,
} from "./auth.ts";
import { registerApiRoutes } from "./api.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { registerWebhookRoutes } from "./webhooks.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  hasGitHubClient?: boolean;
  logger?: boolean;
}

const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const credentials = await createCredentialVerifier(config.adminUsername, config.adminPassword);
  const serverOptions: FastifyServerOptions = {
    logger: deps.logger ?? false,
    // Production traffic reaches the app through exactly one load balancer.
    trustProxy: config.production ? (_address, hop) => hop === 0 : false,
  };
  const app = Fastify(serverOptions);

  await app.register(cookie);
  await app.register(helmet, {
    // Vite injects inline scripts during development.
    contentSecurityPolicy: config.production
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    const token = request.cookies[SESSION_COOKIE];
    request.session = token ? await findSession(db, token) : null;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) {
      reply.code(status).send({ ok: false, error: status === 429 ? "RATE_LIMITED" : "BAD_REQUEST" });
      return;
    }
    // The error name is logged; provider messages and payloads are not.
    request.log.error({ errorName: error.name }, "request failed");
    reply.code(500).send({ ok: false, error: "INTERNAL_ERROR" });
  });

  const originAllowed = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    return origin === undefined || origin === config.appOrigin;
  };

  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.code(401).send({ ok: false, error: "UNAUTHENTICATED" });
    }
  };

  const requireMutation = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.code(401).send({ ok: false, error: "UNAUTHENTICATED" });
    }
    const csrf = request.headers["x-csrf-token"];
    if (
      !originAllowed(request) ||
      typeof csrf !== "string" ||
      !safeEqual(csrf, request.session.csrfToken)
    ) {
      return reply.code(403).send({ ok: false, error: "FORBIDDEN" });
    }
  };

  app.decorate("requireSession", requireSession);
  app.decorate("requireMutation", requireMutation);

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  app.get("/api/session", async (request) => {
    if (!request.session) return { authenticated: false };
    return {
      authenticated: true,
      username: request.session.username,
      csrfToken: request.session.csrfToken,
    };
  });

  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!originAllowed(request)) {
        return reply.code(403).send({ ok: false, error: "FORBIDDEN" });
      }
      const body = loginSchema.safeParse(request.body);
      if (!body.success || !(await credentials.verify(body.data.username, body.data.password))) {
        return reply.code(401).send({ ok: false, error: "INVALID_CREDENTIALS" });
      }
      const { token, csrfToken } = await createSession(db, config.targetAccount, body.data.username);
      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: config.production,
        maxAge: SESSION_TTL_SECONDS,
      });
      return { ok: true, username: body.data.username, csrfToken };
    },
  );

  app.post("/api/logout", { preHandler: requireMutation }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  await registerWebhookRoutes(app, { config, db });
  await registerApiRoutes(app, { config, db, hasGitHubClient: deps.hasGitHubClient ?? false });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireMutation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}
