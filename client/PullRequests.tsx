import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { Drawer, Empty, OutcomeStatus, RunStatus } from "./components.tsx";
import { dateTime, label, plural, shortSha, usd } from "./format.ts";
import type { PullRequest, PullRequestDetail, ReviewRun, RunState } from "./types.ts";

const STATE_FILTERS: Array<RunState | "all" | "none"> = [
  "all",
  "completed",
  "partial",
  "failed",
  "publishing",
  "reviewing",
  "queued",
  "superseded",
  "skipped",
  "none",
];

function coverageNote(run: ReviewRun): string | null {
  const coverage = run.coverage;
  if (!coverage) return null;
  const parts = [`${plural(coverage.filesReviewed, "file")} of ${coverage.filesChanged} reviewed`];
  if (coverage.excluded.length > 0) parts.push(`${coverage.excluded.length} excluded`);
  if (coverage.missingSource.length > 0) parts.push(`${coverage.missingSource.length} missing source`);
  if (coverage.omittedDiffs.length > 0) parts.push(`${coverage.omittedDiffs.length} without a diff`);
  if (coverage.contextLimited.length > 0) parts.push(`${coverage.contextLimited.length} over the size limit`);
  if (coverage.fileLimitReached) parts.push("file limit reached");
  return parts.join(", ");
}

function RunEntry({ run }: { run: ReviewRun }) {
  return (
    <li className="run-entry">
      <div className="run-entry-head">
        <RunStatus state={run.state} />
        <code>
          {shortSha(run.baseSha)}..{shortSha(run.headSha)}
        </code>
        <span className="muted">{dateTime(run.createdAt)}</span>
      </div>
      {run.summary && <p>{run.summary}</p>}
      {coverageNote(run) && <p className="muted">{coverageNote(run)}</p>}
      <p className="muted">
        {usd(run.costUsd)} estimated
        {run.errorCode && (
          <>
            , stopped with <code>{run.errorCode}</code>
          </>
        )}
      </p>
    </li>
  );
}

function PullRequestDrawer({
  id,
  load,
  onClose,
}: {
  id: string;
  load: (id: string) => Promise<PullRequestDetail>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    load(id)
      .then((result) => current && setDetail(result))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [id, load]);

  const pr = detail?.pullRequest;
  return (
    <Drawer title={pr ? `${pr.repository} #${pr.number}` : "Pull request"} onClose={onClose}>
      {failed && <p className="form-error">This pull request couldn't be loaded.</p>}
      {!detail && !failed && <p className="muted">Loading</p>}
      {detail && pr && (
        <>
          <section>
            <h3>{pr.title}</h3>
            <p className="muted">
              Opened by {pr.author} on {dateTime(pr.openedAt)}
              {pr.draft ? " as a draft" : ""}.{" "}
              <a href={pr.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
            </p>
          </section>
          <section>
            <h3>{plural(detail.runs.length, "review run")}</h3>
            <ul className="run-list">
              {detail.runs.map((run) => (
                <RunEntry key={run.id} run={run} />
              ))}
            </ul>
          </section>
          <section>
            <h3>{plural(detail.findings.length, "posted finding")}</h3>
            {detail.findings.length === 0 ? (
              <p className="muted">No findings were posted on this pull request.</p>
            ) : (
              <ul className="run-list">
                {detail.findings.map((finding) => (
                  <li key={finding.id} className="run-entry">
                    <div className="run-entry-head">
                      <OutcomeStatus outcome={finding.outcome} />
                      <span>{label(finding.severity)}</span>
                    </div>
                    <p>{finding.title}</p>
                    <code className="path">
                      {finding.path}:{finding.line}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

export function PullRequests({
  pullRequests,
  load,
}: {
  pullRequests: PullRequest[];
  load: (id: string) => Promise<PullRequestDetail>;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<(typeof STATE_FILTERS)[number]>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pullRequests.filter((pr) => {
      const matchesState = state === "all" || (state === "none" ? pr.runState === null : pr.runState === state);
      const haystack = `${pr.title} ${pr.repository} ${pr.author} #${pr.number}`.toLowerCase();
      return matchesState && haystack.includes(needle);
    });
  }, [pullRequests, query, state]);

  if (pullRequests.length === 0) {
    return (
      <Empty title="No pull requests in this period">
        Open a pull request in a monitored repository, or choose a longer period.
      </Empty>
    );
  }

  return (
    <>
      <div className="filters">
        <label className="field">
          Search
          <input
            type="search"
            value={query}
            placeholder="Title, repository, or author"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="field">
          Latest review
          <select value={state} onChange={(event) => setState(event.target.value as typeof state)}>
            {STATE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value === "none" ? "Not reviewed" : label(value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <Empty title="No matches">Change the search or the review filter.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Author</th>
                <th scope="col">Latest review</th>
                <th scope="col" className="numeric">
                  Runs
                </th>
                <th scope="col" className="numeric">
                  Findings
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((pr) => (
                <tr key={pr.id}>
                  <td className="primary-cell">
                    <button type="button" className="row-link" onClick={() => setSelected(pr.id)}>
                      {pr.title}
                    </button>
                    <span className="muted">
                      <code>{pr.repository}</code> #{pr.number}
                      {pr.draft ? ", draft" : ""}
                      {pr.state === "closed" ? ", closed" : ""}
                    </span>
                  </td>
                  <td>{pr.author}</td>
                  <td>
                    <RunStatus state={pr.runState} />
                  </td>
                  <td className="numeric">{pr.runCount}</td>
                  <td className="numeric">{pr.findingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <PullRequestDrawer id={selected} load={load} onClose={() => setSelected(null)} />}
    </>
  );
}
