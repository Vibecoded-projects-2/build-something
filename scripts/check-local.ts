import { loadConfig } from "../server/config.ts";

// Uses configured credentials in memory and prints only statuses and booleans.
const config = loadConfig();
const origin = config.appOrigin;

const report: Record<string, unknown> = {};

report.signedOutDashboard = (await fetch(`${origin}/api/dashboard`)).status;

const login = await fetch(`${origin}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }),
});
report.login = login.status;

if (login.ok) {
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  report.cookie = {
    httpOnly: /;\s*HttpOnly/i.test(setCookie),
    sameSiteStrict: /;\s*SameSite=Strict/i.test(setCookie),
    secure: /;\s*Secure/i.test(setCookie),
  };

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { Cookie: cookie } });
  report.dashboard = dashboard.status;
  if (dashboard.ok) {
    const body = (await dashboard.json()) as {
      integrations: Record<string, boolean>;
      repositories: unknown[];
      runs: unknown[];
    };
    report.integrations = body.integrations;
    report.counts = { repositories: body.repositories.length, runs: body.runs.length };
  }

  const logout = await fetch(`${origin}/api/logout`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, Origin: origin },
  });
  report.logout = logout.status;

  const after = await fetch(`${origin}/api/dashboard`, { headers: { Cookie: cookie } });
  report.sessionAfterLogout = after.status;
}

console.log(JSON.stringify(report, null, 2));
