import { useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "./api.ts";
import { Drawer, Empty, OutcomeStatus, Status } from "./components.tsx";
import { dateTime, label } from "./format.ts";
import type { Finding, FindingOutcome } from "./types.ts";

const CATEGORIES = ["correctness", "security", "reliability", "performance", "testing", "maintainability"];
const OUTCOMES: FindingOutcome[] = ["open", "suspected_fixed", "unverifiable", "confirmed_fixed", "dismissed"];

const UPDATE_ERRORS: Record<string, string> = {
  EVIDENCE_REQUIRED: "Describe the evidence in at least five characters.",
  INVALID_FIX_SHA: "Enter the full 40-character commit SHA in lowercase.",
  UNKNOWN_FIX_COMMIT: "Reviewgate has no review of that commit on this pull request.",
};

function updateError(error: unknown): string {
  return (error instanceof ApiError && UPDATE_ERRORS[error.code]) || "This finding couldn't be updated. Try again.";
}

function FindingDrawer({
  finding,
  readOnly,
  onClose,
  onChanged,
}: {
  finding: Finding;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [fixSha, setFixSha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function update(change: Parameters<typeof api.updateFinding>[1]) {
    setBusy(true);
    setError(null);
    try {
      await api.updateFinding(finding.id, change);
      onChanged();
      onClose();
    } catch (caught) {
      setError(updateError(caught));
      setBusy(false);
    }
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    void update({ outcome: "confirmed_fixed", evidence, fixSha: fixSha.trim() });
  }

  return (
    <Drawer title={finding.title} onClose={onClose}>
      <section className="finding-summary">
        <div className="run-entry-head">
          <OutcomeStatus outcome={finding.outcome} />
          <span>{label(finding.severity)}</span>
          <span>{label(finding.category)}</span>
        </div>
        <code className="path">
          {finding.repository} #{finding.prNumber}, {finding.path}:{finding.line}
        </code>
        <p className="muted">
          Posted {dateTime(finding.createdAt)}. Discussion {finding.threadResolved ? "resolved" : "open"}.{" "}
          {finding.commentUrl && (
            <a href={finding.commentUrl} target="_blank" rel="noreferrer">
              Open comment on GitHub
            </a>
          )}
        </p>
      </section>
      <section>
        <h3>What can go wrong</h3>
        <p className="prose">{finding.body}</p>
      </section>
      <section>
        <h3>Evidence</h3>
        <p className="prose">{finding.evidence}</p>
      </section>
      <section>
        <h3>Suggested fix</h3>
        <p className="prose">{finding.suggestion}</p>
      </section>
      {finding.assessment && (
        <section>
          <h3>Latest assessment</h3>
          <p className="prose">{finding.assessment}</p>
        </section>
      )}
      {!readOnly && (
        <>
          <section>
            <h3>Was this useful?</h3>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                aria-pressed={finding.helpful === true}
                disabled={busy}
                onClick={() => void update({ helpful: finding.helpful === true ? null : true })}
              >
                Helpful
              </button>
              <button
                type="button"
                className="secondary"
                aria-pressed={finding.helpful === false}
                disabled={busy}
                onClick={() => void update({ helpful: finding.helpful === false ? null : false })}
              >
                Not helpful
              </button>
            </div>
          </section>
          <form className="stack" onSubmit={confirm}>
            <h3>Confirm the fix</h3>
            <p className="muted">
              Only a confirmed fix counts in fix metrics. A resolved discussion or a model suspicion does not.
            </p>
            <label className="field">
              Evidence
              <textarea rows={2} required value={evidence} onChange={(event) => setEvidence(event.target.value)} />
            </label>
            <label className="field">
              Reviewed commit SHA
              <input required spellCheck={false} value={fixSha} onChange={(event) => setFixSha(event.target.value)} />
            </label>
            <div className="button-row">
              <button type="submit" className="primary" disabled={busy}>
                Confirm fix
              </button>
              {finding.outcome !== "dismissed" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void update({ outcome: "dismissed" })}
                >
                  Dismiss finding
                </button>
              )}
              {(finding.outcome === "dismissed" || finding.outcome === "confirmed_fixed") && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void update({ outcome: "open" })}
                >
                  Reopen finding
                </button>
              )}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </>
      )}
    </Drawer>
  );
}

export function Findings({
  findings,
  readOnly = false,
  onChanged,
}: {
  findings: Finding[];
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [category, setCategory] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      findings.filter(
        (finding) =>
          (category === "all" || finding.category === category) &&
          (outcome === "all" || finding.outcome === outcome),
      ),
    [findings, category, outcome],
  );

  if (findings.length === 0) {
    return (
      <Empty title="No findings in this period">
        Findings appear here once they are posted as comments on a pull request.
      </Empty>
    );
  }

  const selected = findings.find((finding) => finding.id === selectedId);

  return (
    <>
      <div className="filters">
        <label className="field">
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Code outcome
          <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
            <option value="all">All</option>
            {OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <Empty title="No matches">Change the category or outcome filter.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Finding</th>
                <th scope="col">Severity</th>
                <th scope="col">Code outcome</th>
                <th scope="col">Discussion</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((finding) => (
                <tr key={finding.id}>
                  <td className="primary-cell">
                    <button type="button" className="row-link" onClick={() => setSelectedId(finding.id)}>
                      {finding.title}
                    </button>
                    <span className="muted">
                      <code>
                        {finding.path}:{finding.line}
                      </code>{" "}
                      in {finding.repository} #{finding.prNumber}
                    </span>
                  </td>
                  <td>
                    <Status sign={finding.severity === "critical" ? "remove" : "none"}>
                      {label(finding.severity)}
                    </Status>
                  </td>
                  <td>
                    <OutcomeStatus outcome={finding.outcome} />
                  </td>
                  <td>{finding.threadResolved ? "Resolved" : "Open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <FindingDrawer
          finding={selected}
          readOnly={readOnly}
          onClose={() => setSelectedId(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
