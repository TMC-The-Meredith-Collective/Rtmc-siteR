# Production deploy runbook — tmcsolutions-org.net

Written to be executed by **Claude Code on your Windows machine**, with you handling the steps
that touch credentials or dashboards. Run it top to bottom, once. It is safe to re-run any phase.

## How to start

Open Claude Code **in the repo folder** (Phase 0 finds or clones it) and paste:

```
Read docs/DEPLOY-RUNBOOK.md in full, then execute it phase by phase, in order.
Follow every rule in "Guardrails" exactly. Do each [CLAUDE CODE] step yourself and
check its "Expect" line before moving on. At each [YOU] step, stop, tell me exactly
what to do, and wait for me to reply "done" (or paste non-secret output) before
continuing. If any "Expect" check fails, stop and show me the output and the
matching Troubleshooting row. Do not improvise around a failure.
```

**Step owners**

| Tag | Who | Where |
|---|---|---|
| **[CLAUDE CODE]** | Claude Code runs it | Its own Bash tool (Git Bash on Windows), in the repo root |
| **[YOU · terminal]** | You type it | Your own PowerShell window, `cd` to the repo root. Secrets are typed here and nowhere else |
| **[YOU · browser]** | You click it | Cloudflare dashboard (`dash.cloudflare.com`) or your Databricks workspace |

---

## Guardrails (non-negotiable for Claude Code)

1. **Never handle secret values.** Do not ask the user to paste secrets into chat. Do not read, echo, log, or write
   them to any file (`.dev.vars`, `.env`, `*.secrets.json`). Do not pipe them into commands. Secrets are entered only by the
   user at Wrangler's interactive prompt in Phase 2. `npx wrangler secret list` (names only) is the only secret
   command Claude Code may run.
2. **Never delete anything under `C:\Users\david\source`** (any subfolder or repo), and never ask for delete permission
   there. If something needs removing, stop and tell the user what and where. The user deletes it.
3. **Never run** `wrangler delete`, `wrangler secret delete`, or `git push --force`, and never change DNS records or
   Databricks objects. Those are [YOU] steps.
4. **Never edit `wrangler.toml` `[vars]` to hold credentials**, and never run DDL against the leads table.
   Schema changes are migrations and need explicit approval.
5. **Deploy only through `npm run deploy`.** It runs the test suite and a Wrangler dry run first, and refuses to deploy if either fails.
6. On any unexpected output: **stop and report.** Don't retry with variations.

---

## What you are deploying

```
                 tmcsolutions-org.net / www.tmcsolutions-org.net   (Cloudflare custom domains)
                                        │
                     ┌──────────────────┴──────────────────┐
                     │  Worker "tmc-solutions-site"        │
  GET /, /fonts/* ──▶│  static assets from ./public        │  served directly; script never runs
                     │  (_headers → CSP, HSTS, etc.)       │
 POST /api/submit ──▶│  worker/tmc-lead-intake-worker.js   │  origin allowlist → size cap →
                     │  LEAD_LIMITER (3/min per IP hash)   │  rate limit → validate → sanitize
                     └──────────────────┬──────────────────┘
                                        │ OAuth M2M (client credentials, 1-h token)
                                        ▼
         Databricks SQL Statement API → INSERT INTO tmc_solutions_jvs.tmc_solutions.leads
         as service principal "tmc-lead-intake-sp" (USE CATALOG/SCHEMA, SELECT, INSERT; CAN USE one warehouse)
```

One Worker, one `wrangler deploy`, same-origin API (no CORS), no `*.workers.dev` URL. Only `public/` is web-reachable,
so the Worker source, `package.json`, and config files can't be downloaded.

---

## Phase 0: Preflight

**0.1 [CLAUDE CODE] Find or clone the repo.**
```bash
for d in /c/Users/david/source /c/Users/david/source/repos; do
  [ -d "$d" ] && find "$d" -maxdepth 3 -name .git -type d 2>/dev/null | while read g; do
    r=$(dirname "$g"); u=$(git -C "$r" remote get-url origin 2>/dev/null)
    echo "$u" | grep -qi 'rtmc-siter' && echo "FOUND: $r -> $u"; done; done
```
- **If FOUND:** `cd` there, then run `git status --porcelain`. **Expect:** empty output. If it's not empty, stop and show the user
  (do not stash, reset, or discard).
- **If not found:** `git clone https://github.com/TMC-The-Meredith-Collective/Rtmc-siteR.git /c/Users/david/source/Rtmc-siteR && cd /c/Users/david/source/Rtmc-siteR`

**0.2 [CLAUDE CODE] Sync and point origin at the canonical URL.**
```bash
git remote set-url origin https://github.com/TMC-The-Meredith-Collective/Rtmc-siteR.git
git checkout main && git pull --ff-only origin main
```
**Expect:** fast-forward or "Already up to date". Both `wrangler.toml` and `public/index.html` exist at the repo root.
If `--ff-only` fails, stop. The local branch has diverged.

**0.3 [CLAUDE CODE] Toolchain and local verification.**
```bash
node --version          # Expect v20 or newer
npm ci                  # installs the pinned wrangler 4.147.0 from package-lock.json
npm run check           # Expect "# fail 0" and "--dry-run: exiting now."
```
If Node is below v20, stop: the user installs Node LTS from nodejs.org.

**0.4 [CLAUDE CODE] Cloudflare login.**
```bash
npx wrangler login      # opens a browser tab
```
→ **[YOU · browser]** In the tab Wrangler opens, check that the account is the one that owns `tmcsolutions-org.net`, then click **Allow**.
```bash
npx wrangler whoami
```
**Expect:** your email and the account that holds the zone.

**0.5 [YOU · browser] Clear the two hostnames for the Worker.** Custom domains fail if a DNS record already exists on
the hostname.
1. `dash.cloudflare.com` → select **tmcsolutions-org.net** → **DNS** → **Records**.
2. Look only at **A, AAAA, and CNAME** records whose **Name** is `tmcsolutions-org.net` (or `@`) or `www`.
3. If any exist (registrar parking, an earlier Pages attempt, etc.), delete those records yourself.
   **Leave MX and TXT records alone.** They carry Email Routing for `russ.meredith@tmcsolutions-org.net`.
4. **Workers & Pages** → if there is a **Pages** project with `tmcsolutions-org.net` under **Custom domains**, open it →
   **Custom domains** → remove both domains from that project (leave the project itself alone).

Reply "done" with what you found (records removed, or "none").

---

## Phase 1: Databricks service principal (least privilege)

The Worker authenticates as a dedicated service principal with OAuth M2M. It never uses your personal identity or a PAT,
both of which Databricks marks as legacy. Do everything in this phase **[YOU · browser]** in your Databricks workspace.

**1.1 Create the service principal.**
Avatar (top right) → **Settings** → **Identity and access** → **Service principals** → **Manage** → **Add service principal**
→ **Add new**. Name it `tmc-lead-intake-sp`. On Azure, choose **Databricks managed**, not Microsoft Entra ID managed.
→ **Add**.

**1.2 Entitlements.** Open `tmc-lead-intake-sp` → **Configurations**. Keep **Databricks SQL access** checked. Uncheck
**Workspace access** and **Allow cluster creation**. **Update**. Copy the **Application ID** (a UUID). It isn't a secret,
but you'll need it for 1.5 and 2.2.

**1.3 OAuth secret.** Same page → **Secrets** tab → **Generate secret**.
- Lifetime: **365** days. Put a rotation reminder in your calendar 2 weeks before expiry (see Phase 6).
- Scopes: **all APIs**. The scope doesn't add permissions. What this principal can actually touch is limited by the
  grants in 1.4 and 1.5: one warehouse and one table.
- **Generate** → copy the **Secret** into your password manager now. It's shown once.
  **Don't paste it into Claude Code or any chat.**

**1.4 Warehouse access.** **SQL Warehouses** → pick the warehouse (a **Serverless** warehouse is strongly recommended;
classic warehouses can take longer than the Worker's 30-second wait on a cold start) → **Permissions** → add
`tmc-lead-intake-sp` → **Can use** → **Save**. Then **Connection details** → copy the warehouse ID (the last segment of
**HTTP path**, `/sql/1.0/warehouses/<this-part>`).

**1.5 Table grants.** Open a **SQL editor** on that warehouse and run, replacing `<application-id>` (keep the backticks):
```sql
GRANT USE CATALOG ON CATALOG tmc_solutions_jvs                        TO `<application-id>`;
GRANT USE SCHEMA  ON SCHEMA  tmc_solutions_jvs.tmc_solutions          TO `<application-id>`;
GRANT SELECT      ON TABLE   tmc_solutions_jvs.tmc_solutions.leads    TO `<application-id>`;
GRANT INSERT      ON TABLE   tmc_solutions_jvs.tmc_solutions.leads    TO `<application-id>`;

SHOW GRANTS `<application-id>` ON TABLE tmc_solutions_jvs.tmc_solutions.leads;
```
- **Expect:** `SHOW GRANTS` lists `SELECT` and `INSERT`.
- **If the `GRANT INSERT` line errors:** fine-grained DML privileges are in Beta and may not be enabled in your workspace.
  Run this instead:
  `GRANT MODIFY ON TABLE tmc_solutions_jvs.tmc_solutions.leads TO \`<application-id>\`;`
  Residual risk: `MODIFY` also permits UPDATE and DELETE. Switch to `INSERT` when it becomes available.
- `SELECT` is required alongside INSERT. It means a leaked credential could read the leads, which is why the secret
  lives only in Cloudflare's encrypted secret store and rotates yearly.

**1.6 Workspace host.** Copy the hostname from your browser's address bar while in the workspace, **without**
`https://` or any path (for example, `adb-1234567890123456.7.azuredatabricks.net` or `dbc-a1b2c3d4-e5f6.cloud.databricks.com`).

Reply "done" to Claude Code. **Send no values.**

---

## Phase 2: Load secrets into the Worker

**2.1 [CLAUDE CODE]** Print the exact commands for the user (don't run them):
```
cd <repo root>
npx wrangler secret put DATABRICKS_HOST
npx wrangler secret put DATABRICKS_WAREHOUSE_ID
npx wrangler secret put DATABRICKS_CLIENT_ID
npx wrangler secret put DATABRICKS_CLIENT_SECRET
```

**2.2 [YOU · terminal]** In **your own PowerShell**, from the repo root, run each line. At the hidden prompt, paste:

| Secret | Value |
|---|---|
| `DATABRICKS_HOST` | host from 1.6 (no `https://`) |
| `DATABRICKS_WAREHOUSE_ID` | warehouse ID from 1.4 |
| `DATABRICKS_CLIENT_ID` | Application ID from 1.2 |
| `DATABRICKS_CLIENT_SECRET` | secret from 1.3 (from your password manager) |

On the first command, Wrangler says there's no Worker called `tmc-solutions-site` and asks whether to create one. Answer
**Y**. That creates an empty placeholder Worker to hold the secrets. It has no domains attached until Phase 3.

*Fallback if Wrangler doesn't offer to create it:* dashboard → **Workers & Pages** → **Create** → **Worker** → start from
"Hello World" → name it exactly `tmc-solutions-site` → **Deploy**. Then rerun the four commands.

**2.3 [CLAUDE CODE] Verify names only.**
```bash
npx wrangler secret list
```
**Expect:** exactly these four names: `DATABRICKS_HOST`, `DATABRICKS_WAREHOUSE_ID`, `DATABRICKS_CLIENT_ID`,
`DATABRICKS_CLIENT_SECRET`.

---

## Phase 3: Deploy

**3.1 [CLAUDE CODE]**
```bash
npm run deploy
```
**Expect**, in order:
1. `# fail 0` (20 tests)
2. `--dry-run: exiting now.`
3. Upload summary, then a **Deployed tmc-solutions-site triggers** section listing
   `tmcsolutions-org.net (custom domain)` and `www.tmcsolutions-org.net (custom domain)`
4. A `Current Version ID: …`. Record it in your report to the user (it's the rollback target for the next deploy).

Wrangler will refuse to deploy if any secret is missing (`[secrets] required` in `wrangler.toml`). That's intended:
go back to Phase 2.

Certificates for new custom domains usually issue within a few minutes. Before Phase 4, wait until this returns `200`:
```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' https://tmcsolutions-org.net/)" = "200" ]; do sleep 15; done; echo ready
```
(Stop waiting and report if it hasn't returned 200 after 20 minutes.)

---

## Phase 4: Verify production

**4.1 [CLAUDE CODE] Edge checks.** Run, then compare against **Expect**:
```bash
B=https://tmcsolutions-org.net
curl -s -D - -o /dev/null $B/ | grep -iE '^(HTTP|content-security-policy|strict-transport-security|x-frame-options)'
for p in /_headers /package.json /wrangler.toml /worker/tmc-lead-intake-worker.js /.git/config; do
  printf "%-36s %s\n" $p "$(curl -s -o /dev/null -w '%{http_code}' $B$p)"; done
printf "www           %s\n" "$(curl -s -o /dev/null -w '%{http_code}' https://www.tmcsolutions-org.net/)"
printf "GET api       %s\n" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/submit)"
printf "evil origin   %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' $B/api/submit)"
```
**Expect:** `HTTP/2 200` with `content-security-policy`, `strict-transport-security` and `x-frame-options: DENY`
present. Every listed path returns `404`. `www` returns `200`, `GET api` returns `405`, `evil origin` returns `403`.

**4.2 [CLAUDE CODE] One real end-to-end submission.**
```bash
curl -s -w ' %{http_code}\n' -X POST https://tmcsolutions-org.net/api/submit \
  -H 'Origin: https://tmcsolutions-org.net' -H 'Content-Type: application/json' \
  -d '{"name":"Deploy Smoke Test","email":"smoke-test@tmcsolutions-org.net","service":"other","message":"Runbook phase 4.2"}'
```
**Expect:** `{"ok":true} 200`. The first call may take up to ~30 s if the warehouse is cold.

**If it returns 500:** in a **second** Claude Code shell, start `npx wrangler tail --format pretty`. Re-run the curl
**once**, read the `[tmc-lead-intake] write failed: …` line, stop tail, and match it in **Troubleshooting**. Don't
re-run more than twice in a minute; the rate limiter allows 3.

**4.3 [YOU · browser] Confirm the row landed.** Databricks SQL editor:
```sql
SELECT id, submitted_at, name, email, service, length(ip_hash) AS hash_len
FROM tmc_solutions_jvs.tmc_solutions.leads
ORDER BY submitted_at DESC LIMIT 5;
```
**Expect:** the "Deploy Smoke Test" row, `submitted_at` within the last few minutes (UTC), `hash_len` = 64. You can
delete the test row yourself later. The service principal can't.

**4.4 [YOU · browser] Real browser pass.** Open `https://tmcsolutions-org.net` in a private window. Confirm the page renders
(animations and counters run, and repo cards appear), then submit the form once with your own details. **Expect:** "Transmission
received…" and a second row in 4.3's query. Open `https://www.tmcsolutions-org.net` and confirm it renders too.

**Production is done when 4.1–4.4 all pass.** Claude Code: report the version ID, the 4.1 table, and the 4.2 response.

---

## Phase 5 (optional): Matrix-Sans fonts

Until the font files exist, the page falls back to Courier New, then monospace. To add them:

1. **[YOU]** Confirm that your Matrix-Sans license permits **web self-hosting**.
2. **[YOU]** Put the files in `public/fonts/` with **exactly** these names (whichever formats you have; `.woff2` matters most):
   `Matrix-Sans.woff2`, `Matrix-Sans.woff`, `Matrix-Sans.otf`, `Matrix-Sans-Bold.woff2`, `Matrix-Sans-Bold.woff`, `Matrix-Sans-Bold.otf`
3. **[CLAUDE CODE]** `npm run deploy`, check `curl -s -o /dev/null -w '%{http_code}' https://tmcsolutions-org.net/fonts/Matrix-Sans.woff2`
   returns `200`, then `git add public/fonts && git commit -m "feat: add Matrix-Sans webfonts" && git push origin main`.

---

## Phase 6: Operating it

| Task | How |
|---|---|
| **Change the page** | Edit `public/index.html`. If you touched anything inside `<script>…</script>`, run `npm run csp:update` (the CSP pins that script's hash; `npm test` fails if it's stale). Then `npm run deploy`, commit, and push. |
| **Roll back** | `npx wrangler deployments list` → `npx wrangler rollback <version-id>` (version from a previous Phase 3.1 report). Rolls back code and assets; secrets aren't affected. |
| **Watch live errors** | `npx wrangler tail --format pretty`. Logs carry status codes and error codes only, never lead data. |
| **Rotate the OAuth secret** (yearly, before expiry) | Databricks: `tmc-lead-intake-sp` → **Secrets** → **Generate secret** → **[YOU · terminal]** `npx wrangler secret put DATABRICKS_CLIENT_SECRET` → rerun Phase 4.2 → then delete the **old** secret in Databricks. |
| **Suspected credential leak** | Databricks: delete the SP's secret immediately (the API stops working, and the form shows the "email us directly" fallback). Generate a new one and `secret put` it. Review recent rows. |
| **Auto-deploy on push** (optional) | Dashboard → **Workers & Pages** → `tmc-solutions-site` → **Settings** → **Builds** → **Connect** → repo `TMC-The-Meredith-Collective/Rtmc-siteR`, branch `main`, deploy command `npm run deploy`. Runtime secrets persist on the Worker and don't go into build settings. |
| **Redirect `www` → apex** (optional SEO polish) | Currently both hostnames serve the site, and `<link rel="canonical">` points search engines at the apex. To hard-redirect instead: dashboard → zone → **Rules** → **Redirect Rules** → template **Redirect from WWW to root** → Deploy. |

---

## Troubleshooting

| Symptom (where you see it) | Cause | Fix |
|---|---|---|
| `npm run deploy` → custom domain / "existing DNS record" / hostname conflict | A/AAAA/CNAME already on `@` or `www` | Phase 0.5, then rerun 3.1 |
| `npm run deploy` → missing required secrets | Phase 2 incomplete | Phase 2.2 for the names `secret list` doesn't show |
| `npm run deploy` → authentication / "not logged in" | Wrangler session expired | `npx wrangler login`, then 3.1 |
| Phase 3 wait loop never reaches 200 | Certificate still issuing, or domain attached to another project | Dashboard → `tmc-solutions-site` → **Settings** → **Domains & Routes**: both domains present and **Active**? If they show "Pending", wait; if they're missing, recheck 0.5 |
| tail: `write failed: token endpoint HTTP 401` (or 400) | Wrong `DATABRICKS_CLIENT_ID` / `_SECRET`, or wrong host | Re-enter the three with `secret put` (2.2), then 4.2 |
| tail: `write failed: statements HTTP 403` | SP lacks **Can use** on the warehouse, or **Databricks SQL access** entitlement | 1.4 / 1.2 |
| tail: `write failed: statements HTTP 404` / `400` | Wrong `DATABRICKS_WAREHOUSE_ID` | Re-enter it (2.2) |
| tail: `statement FAILED PERMISSION_DENIED` (or `INSUFFICIENT_PERMISSIONS`) | Missing UC grant | 1.5; confirm with `SHOW GRANTS` |
| tail: `statement FAILED TABLE_OR_VIEW_NOT_FOUND` | Missing `USE CATALOG` / `USE SCHEMA`, or table not created | 1.5; check the table exists (`docs/leads-table.sql`) |
| tail: `statement CANCELED` | Warehouse cold start > 30 s | Use a Serverless warehouse (1.4), or start the warehouse and retry |
| Browser form says "Forbidden." | Page opened from a host not in `ALLOWED_ORIGINS` | Use `https://tmcsolutions-org.net` or `www`; don't use a raw IP or another domain |
| Browser form says "Too many requests" | 3 submissions per minute per IP | Wait 60 s |
| Page loads but is static (no counters or repo cards), console shows CSP "Refused to execute inline script" | Inline script edited without updating its hash | `npm run csp:update`, then `npm run deploy` |
