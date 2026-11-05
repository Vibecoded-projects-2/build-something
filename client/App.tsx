import { Activity, FolderGit2, GitPullRequest, LayoutDashboard, LogOut, MessageSquareCode, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { api, ApiError } from "./api.ts";
import { Findings } from "./Findings.tsx";
import { Login } from "./Login.tsx";
import { Operations } from "./Operations.tsx";
import { Overview } from "./Overview.tsx";
import { PullRequests } from "./PullRequests.tsx";
import { Repositories } from "./Repositories.tsx";
import { sampleDashboard, samplePullRequest } from "./sample.ts";
import { Settings } from "./Settings.tsx";
import type { Dashboard, DashboardWindow, Session } from "./types.ts";

const REFRESH_MS = 15_000;
const WINDOWS: DashboardWindow[] = [7, 30, 90];
const WINDOWED_VIEWS = new Set<string>(["overview", "pulls", "findings", "operations"]);

type ViewId = "overview" | "repositories" | "pulls" | "findings" | "operations" | "settings";

const NAVIGATION: Array<{ id: ViewId; name: string; icon: ComponentType<{ size?: number }> }> = [
  { id: "overview", name: "Overview", icon: LayoutDashboard },
  { id: "repositories", name: "Repositories", icon: FolderGit2 },
  { id: "pulls", name: "Pull requests", icon: GitPullRequest },
  { id: "findings", name: "Findings", icon: MessageSquareCode },
  { id: "operations", name: "Operations", icon: Activity },
  { id: "settings", name: "Settings", icon: SettingsIcon },
];

function Workspace({ sample = false, onSignedOut }: { sample?: boolean; onSignedOut: () => void }) {
  const [view, setView] = useState<ViewId>("overview");
  const [days, setDays] = useState<DashboardWindow>(30);
  const [data, setData] = useState<Dashboard | null>(sample ? sampleDashboard : null);
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
    // Sample mode never contacts the live API.
    if (sample) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, sample]);

  async function signOut() {
    if (!sample) await api.logout();
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
          <span>{sample ? "Leave sample" : "Sign out"}</span>
        </button>
      </aside>

      <main className="content">
        <header className="content-header">
          <h1>{current.name}</h1>
          {WINDOWED_VIEWS.has(view) && !sample && (
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
          )}
        </header>

        {sample && (
          <p className="banner" role="note">
            This is a read-only sample. None of it came from a real repository.
          </p>
        )}

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
          <Repositories repositories={data.repositories} readOnly={sample} onChanged={() => void refresh()} />
        )}
        {data && view === "pulls" && <PullRequests pullRequests={data.pullRequests} load={sample ? samplePullRequest : api.pullRequest} />}
        {data && view === "findings" && (
          <Findings findings={data.findings} readOnly={sample} onChanged={() => void refresh()} />
        )}
        {data && view === "operations" && <Operations data={data} readOnly={sample} onChanged={() => void refresh()} />}
        {data && view === "settings" && <Settings data={data} readOnly={sample} onChanged={() => void refresh()} />}
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sample, setSample] = useState(() => new URLSearchParams(location.search).get("demo") === "1");

  const leaveSample = useCallback(() => {
    history.replaceState(null, "", "/");
    setSample(false);
  }, []);

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

  if (sample) return <Workspace sample onSignedOut={leaveSample} />;
  if (!session) return null;
  if (!session.authenticated) {
    return <Login onSignedIn={() => void loadSession()} onViewSample={() => setSample(true)} />;
  }
  return <Workspace onSignedOut={() => setSession({ authenticated: false })} />;
}
