import { useState } from "react";
import { api } from "./api.ts";
import { Empty, Status } from "./components.tsx";
import { dateTime } from "./format.ts";
import type { Repository } from "./types.ts";

function monitoringState(repository: Repository) {
  if (!repository.accessible || !repository.installationActive) {
    return <Status sign="remove">Access removed</Status>;
  }
  if (repository.archived) return <Status sign="none">Archived</Status>;
  if (!repository.enabled) return <Status sign="change">Paused</Status>;
  return <Status sign="add">Monitored</Status>;
}

export function Repositories({
  repositories,
  readOnly = false,
  onChanged,
}: {
  repositories: Repository[];
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(repository: Repository) {
    setBusy(repository.id);
    setError(null);
    try {
      await api.setMonitoring(repository.id, !repository.enabled);
      onChanged();
    } catch {
      setError(`${repository.fullName} couldn't be updated. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  if (repositories.length === 0) {
    return (
      <Empty title="No repositories yet">
        Repositories appear after the GitHub App is installed and a sync finishes.
      </Empty>
    );
  }

  return (
    <>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Visibility</th>
              <th scope="col">State</th>
              <th scope="col" className="numeric">
                Reviewed PRs
              </th>
              <th scope="col">Last review</th>
              <th scope="col">
                <span className="visually-hidden">Monitoring</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repository) => (
              <tr key={repository.id}>
                <td>
                  <code>{repository.fullName}</code>
                </td>
                <td>{repository.private ? "Private" : "Public"}</td>
                <td>{monitoringState(repository)}</td>
                <td className="numeric">{repository.reviewCount}</td>
                <td>{dateTime(repository.lastReviewAt)}</td>
                <td className="row-action">
                  {!readOnly && repository.accessible && !repository.archived && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === repository.id}
                      aria-label={`${repository.enabled ? "Pause" : "Resume"} ${repository.fullName}`}
                      onClick={() => void toggle(repository)}
                    >
                      {repository.enabled ? "Pause" : "Resume"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
