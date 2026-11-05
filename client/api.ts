import type { Dashboard, DashboardWindow, PullRequestDetail, Session } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

let csrfToken: string | undefined;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

  // Some handlers report failure in a 200 response, so both are checked.
  if (!response.ok || body?.ok === false) {
    throw new ApiError(body?.error ?? "REQUEST_FAILED", response.status);
  }
  return body as T;
}

function send<T = { ok: true }>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

export const api = {
  async session(): Promise<Session> {
    const session = await request<Session>("/api/session");
    csrfToken = session.csrfToken;
    return session;
  },
  async login(username: string, password: string): Promise<void> {
    const result = await send<{ csrfToken: string }>("POST", "/api/login", { username, password });
    csrfToken = result.csrfToken;
  },
  async logout(): Promise<void> {
    await send("POST", "/api/logout");
    csrfToken = undefined;
  },
  dashboard: (days: DashboardWindow) => request<Dashboard>(`/api/dashboard?days=${days}`),
  pullRequest: (id: string) => request<PullRequestDetail>(`/api/prs/${encodeURIComponent(id)}`),
  sync: () => send("POST", "/api/sync"),
  setMonitoring: (id: number, enabled: boolean) => send("PATCH", `/api/repos/${id}`, { enabled }),
  retryRun: (id: string) => send("POST", `/api/runs/${id}/retry`),
  updateFinding: (
    id: string,
    update: { outcome?: string; evidence?: string; fixSha?: string; helpful?: boolean | null },
  ) => send("PATCH", `/api/findings/${id}`, update),
};
