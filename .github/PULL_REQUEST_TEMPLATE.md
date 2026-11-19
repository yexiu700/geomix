## Summary

<!-- Briefly describe the problem, root cause, and what this PR changes. -->

## Linked Issue

<!-- e.g. Closes #123 or Refs #123 -->

## Verification

- [ ] `pnpm lint` (ESLint + Prettier)
- [ ] `pnpm typecheck` (including `e2e/tsconfig.json`)
- [ ] `pnpm test`
- [ ] DB / Redis integration tests (`GEOMIX_DB_INTEGRATION=1` / `GEOMIX_REDIS_INTEGRATION=1`, if applicable)
- [ ] Playwright E2E (`pnpm test:e2e`, if UI / API contract changed)

## Guardrails & Compliance Checklist

- [ ] No secrets or `.env` files committed; any new config keys are added to `.env.example`
- [ ] `BILLING_MODE=SHADOW` default and multi-tenant isolation (`prisma.scoped` / `AdminGuard` / `TenantActiveGuard`) are preserved
- [ ] No third-party/origin copy, logos, URLs, or image binaries under `docs/`
- [ ] Aware that non-draft PRs auto-merge and trigger CD after CI passes (mark as **Draft** if still WIP or awaiting manual review)
