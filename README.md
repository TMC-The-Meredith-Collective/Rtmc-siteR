# tmcsolutions-site

The site and lead-intake API for **tmcsolutions-org.net**, deployed as **one Cloudflare Worker** with static assets.
There's no framework and no build step.

**First production deploy: follow [`docs/DEPLOY-RUNBOOK.md`](docs/DEPLOY-RUNBOOK.md).**

## Layout

| Path | Purpose | Public? |
|---|---|---|
| `public/index.html` | The landing page (single file; one inline `<script>`) | yes |
| `public/fonts/` | Self-hosted Matrix-Sans webfonts (`MatrixSans-Regular.*`, `MatrixSans-Bold.*`; see runbook Phase 5) | yes |
| `public/_headers` | Security headers for assets: CSP (script pinned by SHA-256), HSTS, frame/referrer/permissions policy | applied, not served |
| `worker/tmc-lead-intake-worker.js` | `POST /api/submit` → Databricks | no |
| `wrangler.toml` | Worker config: custom domains, assets, rate limit, required secrets | no |
| `scripts/csp-update.mjs` | Rewrites the CSP script hash after you edit the inline script | no |
| `test/` | `node:test` suites: Worker contract plus site guards (CSP drift, placeholders, form↔API fields) | no |
| `docs/tmc_site_leads-table.sql` | Schema of record for the tmc_site_leads table | no |

Only `public/` is web-reachable.

## Commands

Requires Node.js 22+ (wrangler 4.147.0 refuses to run on older versions).

```bash
npm ci                 # install pinned wrangler (4.147.0)
npm test               # 22 tests, no network
npm run check          # tests + wrangler dry-run (validates config and bundles the Worker)
npm run csp:update     # after ANY edit inside <script> in public/index.html
npm run deploy         # check, then deploy (the only supported deploy path)
```

## API: `POST /api/submit`

Same-origin JSON endpoint used by the contact form.

| | |
|---|---|
| Request | `Content-Type: application/json`, body ≤ 8 KB, `Origin` ∈ `ALLOWED_ORIGINS` |
| Body | `name`*, `email`*, `message`*, `company`, `service` (one of `owner-operator`, `growing-business`, `developer-collab`, `investor-partner`, `other`), `phone`, `budget` |
| 200 | `{"ok":true}`: row inserted |
| 400 / 403 / 404 / 405 / 413 / 415 / 429 | Validation / origin / path / method / size / content-type / rate limit (3 per 60 s per IP hash) |
| 500 | Databricks write failed; generic message to the visitor; status and error code (never data) logged |

The Worker writes `tmc_solutions_jvs.tmc_solutions.tmc_site_leads` (see `docs/tmc_site_leads-table.sql`) with a parameterized INSERT,
authenticating as service principal `tmc-lead-intake-sp` via OAuth M2M. The raw visitor IP is hashed (SHA-256) and is
never stored or forwarded.

## Configuration

- `[vars]` (in `wrangler.toml`, non-sensitive): `ALLOWED_ORIGINS`, `DATABRICKS_OAUTH_SCOPE`
- Secrets (set with `npx wrangler secret put`; in PowerShell use `npx.cmd`; never committed): `DATABRICKS_HOST`, `DATABRICKS_WAREHOUSE_ID`,
  `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`. Deploy refuses to run if any are missing.

## Before publishing

- Confirm `russ.meredith@tmcsolutions-org.net` routes (Cloudflare Email Routing). The 500 fallback message points there.
- Footer shows "TMC Solutions" until the LLC filing completes.

## Backlog

- Careerjet jobs page (`jobs.html`): not built yet.
