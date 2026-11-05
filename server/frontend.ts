import { existsSync } from "node:fs";
import { resolve } from "node:path";
import middie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.ts";

/** Serves built assets in production and Vite middleware during development. */
export async function registerFrontend(app: FastifyInstance, config: AppConfig): Promise<() => Promise<void>> {
  if (config.production) {
    const root = resolve("dist/client");
    if (!existsSync(root)) throw new Error("Missing dist/client. Run the build first.");
    await app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url.startsWith("/api/") || request.url.startsWith("/webhooks/")) {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
      }
      return reply.sendFile("index.html");
    });
    return async () => {};
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: resolve("vite.config.ts"),
    server: { middlewareMode: true, hmr: { port: config.port + 10_000 } },
    appType: "spa",
  });
  await app.register(middie);
  app.use((request, response, next) => {
    const url = request.url ?? "";
    if (url.startsWith("/api/") || url.startsWith("/webhooks/")) return next();
    vite.middlewares(request, response, next);
  });
  return () => vite.close();
}
