# Security Policy

## Reporting a Vulnerability

We take security issues in **GeoMix** seriously. **Please do not open a public GitHub issue for suspected security vulnerabilities.**

Instead, please report them privately using one of the following channels:

1. **GitHub Private Vulnerability Reporting** (preferred): Open a draft security advisory under **Security → Advisories → Report a vulnerability** in this repository.
2. If private advisories are unavailable, contact the repository maintainer (`@yexiu700`) privately before disclosing any details publicly.

Please include:

- A clear description of the vulnerability and potential impact (e.g., cross-tenant data exposure, SSRF bypass, auth bypass, privilege escalation).
- Minimal reproduction steps or proof-of-concept request/payload.
- Relevant commit SHA or branch if known.

We aim to acknowledge reports promptly and coordinate a fix before public disclosure.

---

## Built-In Security Boundaries

GeoMix enforces several security controls by design and verifies them via automated tests:

- **Multi-Tenant Isolation**: Business queries use `PrismaService.scoped` with `AsyncLocalStorage` tenant binding; models without `tenantId` (`KnowledgeChunk`, `AiTaskItem`) require explicit parent ownership verification.
- **Role & Expiry Enforcement**: Admin endpoints require `AdminGuard` (returning `404` to non-admin accounts to avoid endpoint probing); write endpoints enforce `TenantActiveGuard` (`403` / `40301` for inactive or expired tenants).
- **SSRF & Outbound Fetch Protection**: Public web fetching and remote provider requests validate resolved IPv4/IPv6 addresses (blocking private, loopback, link-local, and metadata ranges), pin connections, re-validate redirects (max 3), enforce size/MIME limits, and honor `robots.txt`.
- **Content & File Hygiene**: Uploaded/generated images are validated for size/pixel limits, re-encoded, and stripped of EXIF metadata; CSV/XLSX exports escape spreadsheet formula prefixes (`=`, `+`, `-`, `@`); rich HTML is sanitized before rendering/storage.
- **Credential & Secrets Hygiene**: Passwords use asynchronous `scrypt` hashing (`scrypt$N$r$p$salt$hash`), login/captcha endpoints enforce rate limits, and real API keys / `.env` files are strictly excluded from Git.
