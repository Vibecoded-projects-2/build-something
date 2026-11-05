import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { loadConfig } from "../server/config.ts";
import { assertPrivateFile, setEnvValues } from "./env-file.ts";

/**
 * Registers the GitHub App through GitHub's manifest flow.
 * Open http://localhost:4311 in a browser signed in as an owner of the target account.
 *
 *   node --import tsx scripts/github-setup.ts --origin=https://YOUR-APP-ORIGIN --owner-type=organization
 */
const ENV_FILE = ".env.local";
const PORT = 4311;

const { values: args } = parseArgs({
  options: {
    origin: { type: "string" },
    "owner-type": { type: "string", default: "organization" },
  },
});

const origin = args.origin;
const ownerType = args["owner-type"];
if (!origin?.startsWith("https://")) throw new Error("Pass --origin with your HTTPS app origin.");
if (ownerType !== "organization" && ownerType !== "user") {
  throw new Error("--owner-type must be organization or user.");
}

assertPrivateFile(ENV_FILE);

const target = loadConfig().targetAccount;
const state = randomBytes(24).toString("hex");

const manifest = {
  name: `Reviewgate ${target}`.slice(0, 34),
  url: origin,
  hook_attributes: { url: `${origin}/webhooks/github`, active: true },
  redirect_url: `http://localhost:${PORT}/callback`,
  public: false,
  default_permissions: { contents: "read", metadata: "read", pull_requests: "write" },
  default_events: ["pull_request", "pull_request_review_thread", "repository"],
};

const registerUrl =
  ownerType === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(target)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Reviewgate setup</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">${body}`;

let installUrl: string | null = null;

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.pathname === "/") {
      response.end(
        page(`<h1>Register the Reviewgate GitHub App</h1>
          <p>Check that this browser is signed in as an owner of <b>${escapeHtml(target)}</b>.</p>
          <form method="post" action="${escapeHtml(registerUrl)}">
            <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
            <button type="submit">Create GitHub App</button>
          </form>`),
      );
      return;
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        response.statusCode = 400;
        response.end(page("<h1>Registration state did not match. Start again.</h1>"));
        return;
      }

      const exchange = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        { method: "POST", headers: { Accept: "application/vnd.github+json" } },
      );
      if (!exchange.ok) {
        response.statusCode = 502;
        response.end(page(`<h1>GitHub rejected the registration (HTTP ${exchange.status}).</h1>`));
        return;
      }

      const app = (await exchange.json()) as {
        id: number;
        slug: string;
        pem: string;
        webhook_secret: string;
        owner: { login: string } | null;
      };
      if (app.owner?.login.toLowerCase() !== target) {
        response.statusCode = 409;
        response.end(
          page(
            `<h1>The App belongs to the wrong account.</h1><p>Expected ${escapeHtml(target)}. Delete it on GitHub, then start again from the right account.</p>`,
          ),
        );
        return;
      }

      setEnvValues(ENV_FILE, {
        GITHUB_APP_ID: String(app.id),
        GITHUB_APP_SLUG: app.slug,
        GITHUB_PRIVATE_KEY: app.pem,
        GITHUB_WEBHOOK_SECRET: app.webhook_secret,
      });
      installUrl = `https://github.com/apps/${app.slug}/installations/new`;

      // Redirecting keeps the one-time code out of the page people see.
      response.statusCode = 303;
      response.setHeader("Location", "/complete");
      response.end();
      return;
    }

    if (url.pathname === "/complete" && installUrl) {
      response.end(
        page(`<h1>GitHub App registered</h1>
          <p>Credentials are in ${ENV_FILE}. Restart the app so it loads them.</p>
          <p><a href="${escapeHtml(installUrl)}">Install the App</a>, choosing All repositories to cover every repository.</p>
          <p>Registering is not the same as installing, and automation is not running until both are done.</p>`),
      );
      setTimeout(() => server.close(), 1000);
      return;
    }

    response.statusCode = 404;
    response.end(page("<h1>Not found</h1>"));
  })().catch(() => {
    response.statusCode = 500;
    response.end(page("<h1>Setup failed. Start again.</h1>"));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open http://localhost:${PORT} in a browser signed in to the owner account.`);
});
