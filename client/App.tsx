import { Activity, FolderGit2, GitPullRequest, LayoutDashboard, LogOut, MessageSquareCode, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { api, ApiError } from "./api.ts";
import { Login } from "./Login.tsx";
import { Overview } from "./Overview.tsx";
import { PullRequests } from "./PullRequests.tsx";
import { Repositories } from "./Repositories.tsx";
import type { Dashboard, DashboardWindow, Session } from "./types.ts";

const REFRESH_MS = 15_000;
const WINDOWS: DashboardWindow[] = [7, 30, 90];

type ViewId = "overview" | "repositories" | "pulls" | "findings" | "operations" | "settings";

const NAVIGATION: Array<{ id: ViewId; name: string; icon: ComponentType<{ size?: number }> }> = [
  { id: "overview", name: "Overview", icon: LayoutDashboard },
  { id: "repositories", name: "Repositories", icon: FolderGit2 },
  { id: "pulls", name: "Pull requests", icon: GitPullRequest },
  { id: "findings", name: "Findings", icon: MessageSquareCode },
  { id: "operations", name: "Operations", icon: Activity },
  { id: "settings", name: "Settings", icon: SettingsIcon },
];

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [view, setView] = useState<ViewId>("overview");
  const [days, setDays] = useState<DashboardWindow>(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.dashboard(days));
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
      setError("The latest data couldn't be loaded. Showing the last successful refresh.");
    }
  }, [days, onSignedOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function signOut() {
    await api.logout();
    onSignedOut();
  }

  const current = NAVIGATION.find((item) => item.id === view)!;

  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="brand">Reviewgate</p>
        <nav aria-label="Main">
          {NAVIGATION.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={id === view ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={16} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <button type="button" className="nav-item sign-out" onClick={() => void signOut()}>
          <LogOut size={16} />
          <span>Sign out</span>
        </button>
      </aside>

      <main className="content">
        <header className="content-header">
          <h1>{current.name}</h1>
          <div className="window-picker" role="group" aria-label="Time period">
            {WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={value === days}
                onClick={() => setDays(value)}
              >
                {value} days
              </button>
            ))}
          </div>
        </header>

        {error && (
          <p className="banner" role="status">
            {error}
          </p>
        )}

        {!data && !error && <p className="muted">Loading</p>}
        {data && view === "overview" && (
          <Overview data={data} onOpenSettings={() => setView("settings")} />
        )}
        {data && view === "repositories" && (
          <Repositories repositories={data.repositories} onChanged={() => void refresh()} />
        )}
        {data && view === "pulls" && <PullRequests pullRequests={data.pullRequests} load={api.pullRequest} />}
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch {
      setSession({ authenticated: false });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (!session) return null;
  if (!session.authenticated) return <Login onSignedIn={() => void loadSession()} />;
  return <Workspace onSignedOut={() => setSession({ authenticated: false })} />;
}
