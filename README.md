# Reviewgate

An AI GitHub pull request reviewer with a private dashboard.

Reviewgate watches every repository owned by one GitHub account or organization,
reviews new PRs and follow-up commits with a single LLM, verifies its own findings
in a second pass, and posts commit-specific inline comments. A dashboard records
repositories, reviews, findings, code-fix outcomes, latency, cost, and failures.

The project is being built up as a stack of small PRs.

## Develop

Requires Node 22 or newer. Production images use Node 24.

```sh
npm ci
npm run check
npm test
npm run build
```

Create a private `.env.local` with a generated admin password and webhook secret,
then start the app:

```sh
npm run setup
npm run dev
```

Read the password from `.env.local` in your editor. The setup script does not print
it, and an existing file is never overwritten.

Open http://localhost:4310. Local mode runs the worker in the web process and stores
data in embedded PGlite under `.data/postgres`. Do not point two processes at that
directory. Production runs the web service with `RUN_WORKER=false` and a separate
worker using `npm run worker`.

A read-only sample workspace is available from the sign-in screen or at `/?demo=1`.
Its data is illustrative and says nothing about whether integrations are working.

To verify sign-in without printing credentials, while the app is running:

```sh
node --import tsx scripts/check-local.ts
```

To make a paid test of the configured model with synthetic source:

```sh
node --import tsx scripts/smoke-model.ts
```

Neither proves GitHub integration. That needs an installed GitHub App, a reachable
webhook URL, and a real pull request reviewed automatically.

Browser tests expect the app to already be running:

```sh
npm run dev
npm run test:e2e
```

## Deploy

See [docs/deployment.md](docs/deployment.md). Nothing has been deployed from this
repository, and the infrastructure code has not been validated yet.

## Known limits

- One administrator and one target account. No multi-tenant onboarding, roles, or SSO.
- No whole-codebase analysis, and findings anchor to added lines, so deletion-only
  defects can be missed.
- Redaction and duplicate detection are pattern-based.
- The budget is an internal estimate, not a provider-enforced cap.
