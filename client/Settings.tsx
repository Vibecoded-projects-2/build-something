import { useState } from "react";
import { api, ApiError } from "./api.ts";
import { Status } from "./components.tsx";
import { usd } from "./format.ts";
import type { Dashboard } from "./types.ts";

function Integration({ name, ready, hint }: { name: string; ready: boolean; hint: string }) {
  return (
    <li className="setting-row">
      <div>
        <p className="setting-name">{name}</p>
        {!ready && <p className="muted">{hint}</p>}
      </div>
      <Status sign={ready ? "add" : "remove"}>{ready ? "Configured" : "Not configured"}</Status>
    </li>
  );
}

export function Settings({
  data,
  readOnly = false,
  onChanged,
}: {
  data: Dashboard;
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const { integrations, settings, budget, workspace } = data;
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      await api.sync();
      setMessage("Sync queued. Repositories update when it finishes.");
      onChanged();
    } catch (caught) {
      setMessage(
        caught instanceof ApiError && caught.code === "GITHUB_APP_NOT_CONFIGURED"
          ? "Sync needs GitHub App credentials. Add them, then restart the server."
          : "The sync couldn't be queued. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <section aria-labelledby="connections-heading">
        <h2 id="connections-heading">Connections</h2>
        <p className="muted">These show whether credentials are present, not whether a provider accepts them.</p>
        <ul className="setting-list">
          <Integration name="GitHub App" ready={integrations.githubApp} hint="Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY." />
          <Integration name="Webhook secret" ready={integrations.webhookSecret} hint="Set GITHUB_WEBHOOK_SECRET." />
          <Integration name="Anthropic API key" ready={integrations.anthropicKey} hint="Set ANTHROPIC_API_KEY." />
        </ul>
        <div className="button-row">
          {!readOnly && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void sync()}>
              Sync now
            </button>
          )}
          {settings.installUrl && (
            <a href={settings.installUrl} target="_blank" rel="noreferrer">
              Install the GitHub App
            </a>
          )}
        </div>
        {message && <p role="status">{message}</p>}
      </section>

      <section aria-labelledby="scope-heading">
        <h2 id="scope-heading">What gets reviewed</h2>
        <dl className="setting-facts">
          <div>
            <dt>Account</dt>
            <dd>
              <code>{workspace.account}</code>
            </dd>
          </div>
          <div>
            <dt>Repository access</dt>
            <dd>
              {settings.repositorySelection === "all"
                ? "All repositories"
                : settings.repositorySelection === "selected"
                  ? "Selected repositories only"
                  : "No active installation"}
            </dd>
          </div>
          <div>
            <dt>Webhook URL</dt>
            <dd>
              <code className="path">{settings.webhookUrl}</code>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="policy-heading">
        <h2 id="policy-heading">Review limits</h2>
        <dl className="setting-facts">
          <div>
            <dt>Model</dt>
            <dd>
              <code>{workspace.model}</code>
            </dd>
          </div>
          <div>
            <dt>Monthly model budget</dt>
            <dd>
              {usd(budget.spentUsd)} spent and {usd(budget.reservedUsd)} held of {usd(budget.limitUsd)}
            </dd>
          </div>
          <div>
            <dt>Changed files per review</dt>
            <dd>{settings.maxPrFiles}</dd>
          </div>
          <div>
            <dt>Code sent per review</dt>
            <dd>{Math.round(settings.maxContextBytes / 1000)} KB</dd>
          </div>
          <div>
            <dt>Tokens per model pass</dt>
            <dd>
              {settings.maxInputTokens.toLocaleString()} in, {settings.maxOutputTokens.toLocaleString()} out
            </dd>
          </div>
        </dl>
        <p className="muted">The budget is an internal estimate, not a billing cap from the provider.</p>
      </section>

      <section aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Privacy boundaries</h2>
        <ul className="plain-list">
          <li>Repository code is never run.</li>
          <li>Secret files, lockfiles, and binaries are not sent to the model.</li>
          <li>Recognized credentials are removed from what the model sees. This is pattern-based, not a guarantee.</li>
          <li>Findings and evidence are stored and can contain excerpts of your code.</li>
        </ul>
      </section>
    </div>
  );
}
