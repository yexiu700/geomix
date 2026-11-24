# Contributing to GeoMix

Thank you for your interest in contributing to **GeoMix**! This guide summarizes the workflow, standards, and quality gates for human contributors and AI coding agents alike.

> **AI Coding Agents**: Please read [AGENTS.md](AGENTS.md) and [docs/AGENTS.md](docs/AGENTS.md) before modifying code. They document all machine-enforced CI contracts and package guardrails.

---

## Development Setup

1. Ensure **Node.js >= 22**, **pnpm 10**, and **Docker Compose v2** are installed.
2. Install dependencies and generate the Prisma Client:
   ```bash
   pnpm install --frozen-lockfile
   node packages/db/scripts/prisma-cli.mjs generate
   ```
3. (Optional for full-stack local dev or integration tests) Start local backing services:
   ```bash
   cp .env.example .env
   docker compose up -d
   pnpm db:migrate && pnpm db:seed
   pnpm dev
   ```

## Branching & Commit Conventions

- Always branch off the latest `origin/main`:
  ```bash
  git fetch origin main
  git checkout -b <type>/<short-topic> origin/main
  ```
- Recommended branch prefixes: `feat/`, `fix/`, `refactor/`, `perf/`, `docs/`, `chore/`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles, e.g.:
  - `feat(visibility): add citation domain breakdown filter`
  - `fix(studio): guard SSE stream cleanup when switching active brand`
  - `refactor(visibility): extract overview analytics helpers from workspace`
  - `docs: update deployment runbook and architecture index`
- **Never push directly to `main`.** All changes must go through a Pull Request.

## Required Local Checks

Run all three workspace quality gates before pushing:

```bash
pnpm lint       # ESLint across all packages + prettier --check .
pnpm typecheck  # TypeScript checks across workspaces + e2e/tsconfig.json
pnpm test       # Vitest unit & contract test suite
```

Tip: Run `pnpm format` to auto-fix Prettier formatting issues. For fast single-file unit test runs under pnpm 10, pass the path directly without `--`:

```bash
pnpm --filter @geomix/web test components/studio/studio-workspace.spec.tsx
pnpm --filter @geomix/server test src/visibility/visibility.http.spec.ts
```

When changing database schemas, migrations, or queue consumers, also verify with local PostgreSQL / Redis:

```bash
GEOMIX_DB_INTEGRATION=1 pnpm --filter @geomix/server test
GEOMIX_DB_INTEGRATION=1 GEOMIX_REDIS_INTEGRATION=1 pnpm --filter @geomix/server test
```

## Pull Request Workflow & Auto-Merge Notice

- Every PR runs two CI gates in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
  1. `lint, typecheck, test`
  2. `playwright e2e` (full-stack Chromium E2E against PostgreSQL 16 + pgvector and Redis 7)
- **Important (`auto-merge.yml`)**: This repository automatically enables auto-merge on **non-draft (Ready)** PRs and triggers deployment (`cd.yml`) after merge. Open incomplete or review-pending work as a **Draft PR** (`gh pr create --draft`).

## Project Guardrails & Compliance

- **Brand & Originality**: Keep the site name as `GeoMix`. Do not commit third-party copy, logos, screenshots, agreements, prompt originals, or external reference URLs.
- **Billing Safety**: Keep `BILLING_MODE=SHADOW` as the repository default.
- **Secrets & Config**: Never commit `.env` files, real API keys, or private keys. Sync any new environment variable into [`.env.example`](.env.example).
- **No Image Binaries in `docs/`**: `packages/shared/src/qa.spec.ts` rejects committed image binaries under `docs/`.
- **Tech Stack Boundaries**: Do not introduce Tailwind CSS, ProComponents, React Query, ECharts, or wangEditor without prior maintainer approval. See [docs/架构与模块索引.md](docs/架构与模块索引.md) for the live stack.
