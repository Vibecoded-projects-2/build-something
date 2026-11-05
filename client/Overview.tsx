import { lazy, Suspense } from "react";
import { DiffLine, Empty } from "./components.tsx";
import { duration, label, percent, plural, usd } from "./format.ts";
import type { Dashboard } from "./types.ts";

const ActivityChart = lazy(() => import("./Chart.tsx"));

function Categories({ categories }: { categories: Dashboard["categories"] }) {
  const largest = categories[0]?.count ?? 0;
  return (
    <ul className="category-list">
      {categories.map(({ category, count }) => (
        <li key={category}>
          <span>{label(category)}</span>
          <span className="category-bar" style={{ width: `${(count / largest) * 100}%` }} />
          <span className="category-count">{count}</span>
        </li>
      ))}
    </ul>
  );
}

export function Overview({
  data,
  onOpenSettings,
}: {
  data: Dashboard;
  onOpenSettings: () => void;
}) {
  const { metrics, budget } = data;
  const failed = data.runs.filter((run) => run.state === "failed").length;

  return (
    <div className="overview">
      <section aria-label="Summary for this period" className="hunk">
        <p className="hunk-header">
          <code>
            @@ last {data.days} days @@ {data.workspace.account}
          </code>
        </p>
        <ul className="hunk-lines">
          <DiffLine sign={metrics.totalPrs > 0 && metrics.reviewedPrs === metrics.totalPrs ? "add" : "change"}>
            {metrics.reviewedPrs} of {plural(metrics.totalPrs, "pull request")} reviewed
          </DiffLine>
          <DiffLine sign={metrics.findings > 0 ? "add" : "none"}>
            {plural(metrics.findings, "finding")} posted
          </DiffLine>
          <DiffLine sign={metrics.confirmedFixes > 0 ? "add" : "none"}>
            {plural(metrics.confirmedFixes, "fix", "fixes")} confirmed by a person
          </DiffLine>
          <DiffLine sign={metrics.suspectedFixes > 0 ? "change" : "none"}>
            {plural(metrics.suspectedFixes, "fix", "fixes")} suspected by the model
          </DiffLine>
          <DiffLine sign={failed > 0 ? "remove" : "none"}>{plural(failed, "failed review")}</DiffLine>
        </ul>
      </section>

      <dl className="facts">
        <div>
          <dt>Monitored repositories</dt>
          <dd>{metrics.monitoredRepositories}</dd>
        </div>
        <div>
          <dt>Review runs</dt>
          <dd>{metrics.reviewRuns}</dd>
        </div>
        <div>
          <dt>Success rate</dt>
          <dd>{percent(metrics.successRate)}</dd>
        </div>
        <div>
          <dt>Median review time</dt>
          <dd>{duration(metrics.latencyMedianSeconds)}</dd>
        </div>
        <div>
          <dt>95th percentile</dt>
          <dd>{duration(metrics.latencyP95Seconds)}</dd>
        </div>
        <div>
          <dt>Estimated model cost</dt>
          <dd>{usd(metrics.estimatedCostUsd)}</dd>
        </div>
        <div>
          <dt>Budget used in {budget.month}</dt>
          <dd>
            {usd(budget.spentUsd + budget.reservedUsd)} of {usd(budget.limitUsd)}
          </dd>
        </div>
      </dl>

      {metrics.reviewRuns === 0 ? (
        <Empty title="No reviews yet">
          Reviews appear here after the GitHub App is installed and a pull request opens.{" "}
          <button type="button" className="link-button" onClick={onOpenSettings}>
            Check setup
          </button>
        </Empty>
      ) : (
        <div className="overview-detail">
          <section aria-labelledby="activity-heading">
            <h2 id="activity-heading">Review activity</h2>
            <Suspense fallback={<div className="chart" />}>
              <ActivityChart trend={data.trend} days={data.days} />
            </Suspense>
          </section>
          <section aria-labelledby="categories-heading">
            <h2 id="categories-heading">Findings by category</h2>
            {data.categories.length > 0 ? (
              <Categories categories={data.categories} />
            ) : (
              <p className="muted">No findings have been posted in this period.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
