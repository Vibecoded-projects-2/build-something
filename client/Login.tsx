import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api.ts";

function loginError(error: unknown): string {
  if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
    return "That username and password don't match.";
  }
  if (error instanceof ApiError && error.code === "RATE_LIMITED") {
    return "Too many attempts. Wait a minute, then try again.";
  }
  return "Sign-in isn't available right now. Check that the server is running.";
}

export function Login({
  onSignedIn,
  onViewSample,
}: {
  onSignedIn: () => void;
  onViewSample: () => void;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onSignedIn();
    } catch (caught) {
      setError(loginError(caught));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-mark" aria-hidden="true">
        <span>+</span>
        <span>−</span>
      </div>
      <form onSubmit={submit} className="login-form">
        <h1>Sign in to Reviewgate</h1>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in" : "Sign in"}
        </button>
        <button type="button" className="link-button" onClick={onViewSample}>
          View a sample workspace
        </button>
      </form>
    </main>
  );
}
