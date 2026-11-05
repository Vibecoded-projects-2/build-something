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

Run locally with a private `.env.local` that sets at least `ADMIN_PASSWORD`:

```sh
npm run dev
```

Open http://localhost:4310. Local mode runs the worker in the web process and stores
data in embedded PGlite under `.data/postgres`. Do not point two processes at that
directory. Production runs the web service with `RUN_WORKER=false` and a separate
worker using `npm run worker`.
