import { useState } from "react";
import { api } from "./api.ts";
import { Empty, RunStatus } from "./components.tsx";
import { dateTime, shortSha, usd } from "./format.ts";
import type { Dashboard, ReviewRun } from "./types.ts";

function canRetry(run: ReviewRun): boolean {
  return (run.state === "failed" || run.state === "publishing") && run.jobState === "dead";
}

export function Operations({
  data,
  readOnly = false,
  onChanged,
}: {
  data: Dashboard;
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function retry(run: ReviewRun) {
    setBusy(run.id);
    setError(null);
    try {
      await api.retryRun(run.id);
      onChanged();
    } catch {
      setError("This review couldn't be retried. It may already be scheduled.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-large">
      <dl className="facts">
        <div>
          <dt>Waiting jobs</dt>
          <dd>{data.jobs.pending}</dd>
        </div>
        <div>
          <dt>Running jobs</dt>
          <dd>{data.jobs.running}</dd>
        </div>
        <div>
          <dt>Stopped jobs</dt>
          <dd>{data.jobs.dead}</dd>
        </div>
      </dl>

      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      {data.runs.length === 0 ? (
        <Empty title="No review runs in this period">
          Each review of a commit appears here with its cost and any error.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Commit</th>
                <th scope="col">State</th>
                <th scope="col">Queued</th>
                <th scope="col" className="numeric">
                  Cost
                </th>
                <th scope="col">Error</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id}>
                  <td className="primary-cell">
                    {run.prTitle}
                    <span className="muted">
                      <code>{run.repository}</code> #{run.prNumber}
                    </span>
                  </td>
                  <td>
                    <code>{shortSha(run.headSha)}</code>
                  </td>
                  <td>
                    <RunStatus state={run.state} />
                  </td>
                  <td>{dateTime(run.createdAt)}</td>
                  <td className="numeric">{usd(run.costUsd)}</td>
                  <td>{run.errorCode ? <code>{run.errorCode}</code> : <span className="muted">None</span>}</td>
                  <td className="row-action">
                    {!readOnly && canRetry(run) && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy === run.id}
                        aria-label={`Retry review of ${run.repository} #${run.prNumber}`}
                        onClick={() => void retry(run)}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
