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
   **Only exception:** files that `git pull --ff-only` itself moves or removes as part of syncing tracked history (Phase 0.2).
   Never run `rm`, `git clean`, `git reset --hard`, `git stash`, `git checkout -- <path>`, or `git restore` there.
3. **Never run** `wrangler delete`, `wrangler secret delete`, or `git push --force`, and never change DNS records or
   Databricks objects yourself. Those are [YOU] steps. **Exception:** `npm run deploy` in Phase 3.1 creates the two
   custom-domain DNS records for `tmcsolutions-org.net` and `www`. Run it only after the user has replied "done" to
   Phase 0.5. Wrangler in a non-interactive shell **silently overwrites** conflicting records and takes domains away from
   other Workers without asking, so 0.5 is the only protection.
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
[ -d /c/Users/david/source ] && find /c/Users/david/source -maxdepth 4 -name .git -type d -not -path '*/node_modules/*' 2>/dev/null |
  while read g; do r=$(dirname "$g"); u=$(git -C "$r" remote get-url origin 2>/dev/null)
    echo "$u" | grep -qi 'rtmc-siter' && echo "$r -> $u"; done | sort -u
```
- **Exactly one line printed:** `cd` to that path, then run `git status --porcelain`. **Expect:** empty output. If it's not empty, stop and
  show the user (do not stash, reset, or discard anything).
- **More than one line:** stop and ask the user which clone to use.
- **Nothing printed:** `git clone https://github.com/TMC-The-Meredith-Collective/Rtmc-siteR.git /c/Users/david/source/Rtmc-siteR && cd /c/Users/david/source/Rtmc-siteR`

**0.2 [CLAUDE CODE] Sync, then check line endings.**
```bash
git remote get-url origin
```
If the URL already refers to `TMC-The-Meredith-Collective/Rtmc-siteR` or `TMC-The-Meredith-Collective/rtmc-siter` over HTTPS **or** SSH,
leave it unchanged (GitHub redirects the old name). If it points anywhere else, stop and ask the user. Then:
```bash
git checkout main && git pull --ff-only origin main
ls wrangler.toml public/index.html package-lock.json .gitattributes
git ls-files --eol public/index.html public/_headers
```
**Expect:** a fast-forward or "Already up to date". All four files are listed. Both `ls-files` lines show `i/lf` and `w/lf`.
- If `--ff-only` fails, stop. The local branch has diverged.
- If any line shows `w/crlf`, stop and tell the user: "This clone checked files out with CRLF line endings, which breaks the
  CSP script hash. Please re-clone into a fresh folder, or tell me how you'd like to proceed." Don't rewrite or delete files.

**0.3 [CLAUDE CODE] Toolchain and local verification.**
```bash
node --version          # Expect v22 or newer (wrangler 4.147.0 hard-requires 22)
npm ci                  # installs the pinned wrangler 4.147.0 from package-lock.json
npm run check           # Expect "# tests 21", "# fail 0", then "--dry-run: exiting now."
```
If Node is below v22, stop: the user installs the current Node LTS from nodejs.org, reopens the terminal, and you rerun 0.3.

**0.4 [CLAUDE CODE] Cloudflare login.**
```bash
npx wrangler login      # opens a browser tab
```
→ **[YOU · browser]** In the tab Wrangler opens, check that the account is the one that owns `tmcsolutions-org.net`, then click **Allow**.
```bash
npx wrangler whoami
```
**Expect:** your email and the account that holds the zone.

**0.5 [YOU · browser] Clear the two hostnames for the Worker. HARD GATE.**
Claude Code must not run Phase 3 until you reply "done" here. Wrangler, running non-interactively, **overwrites** any
conflicting DNS record and **reassigns** the domains from any other Worker, without prompting.
1. `dash.cloudflare.com` → select **tmcsolutions-org.net** → **DNS** → **Records**.
2. **Write down every MX and TXT record** (name, content). They carry Email Routing for
   `russ.meredith@tmcsolutions-org.net`. You'll compare against this list in Phase 4.5. Don't change them.
3. Look at **A, AAAA, and CNAME** records whose **Name** is `tmcsolutions-org.net` (or `@`) or `www`. If any exist (registrar
   parking, an earlier Pages attempt, etc.), delete those records yourself.
4. **Workers & Pages** → check every project:
   - a **Pages** project with `tmcsolutions-org.net` or `www` under **Custom domains** → open it → **Custom domains** →
     remove those domains (leave the project itself alone);
   - any **Worker** other than `tmc-solutions-site` → **Settings** → **Domains & Routes** listing either hostname → remove
     that domain from it.

Reply "done" with what you found: the records/domains you removed (or "none") and the count of MX/TXT records you noted.

---

## Phase 1: Databricks service principal (least privilege)

The Worker authenticates as a dedicated service principal with OAuth M2M, not as your personal identity and not with a
personal access token (Databricks labels PATs legacy). Do everything in this phase **[YOU · browser]** in your Databricks workspace.

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
- **MODIFY fallback.** Fine-grained `INSERT` is Beta. It needs Databricks Runtime 18.1+ and doesn't apply on compute in
  dedicated access mode, so `GRANT INSERT` can succeed while the actual INSERT is still denied. Switch to the fallback
  **either** when the `GRANT INSERT` line errors **or** when Phase 4.2 fails with a permission error (Troubleshooting):
  ```sql
  GRANT MODIFY ON TABLE tmc_solutions_jvs.tmc_solutions.leads TO `<application-id>`;
  ```
  Residual risk: `MODIFY` also permits UPDATE and DELETE. Note which grant you used. Phase 4.3 and the leak response
  depend on it. Move back to `INSERT` once it works on your warehouse.
- `SELECT` is required alongside INSERT. It means a leaked credential could read the leads, which is why the secret
  lives only in Cloudflare's encrypted secret store and rotates yearly.

**1.6 Workspace host.** Copy the hostname from your browser's address bar while in the workspace, **without**
`https://` or any path (for example, `adb-1234567890123456.7.azuredatabricks.net` or `dbc-a1b2c3d4-e5f6.cloud.databricks.com`).

Reply "done" to Claude Code. **Send no values.**

---

## Phase 2: Load secrets into the Worker

**2.1 [CLAUDE CODE]** Run `pwd -W` to get the repo's Windows path, then print the commands for the user with that path filled
in (don't run them yourself):
```powershell
cd "<output of pwd -W>"
npx.cmd wrangler secret put DATABRICKS_HOST
npx.cmd wrangler secret put DATABRICKS_WAREHOUSE_ID
npx.cmd wrangler secret put DATABRICKS_CLIENT_ID
npx.cmd wrangler secret put DATABRICKS_CLIENT_SECRET
```
(`npx.cmd` rather than `npx`: PowerShell resolves plain `npx` to `npx.ps1`, which Windows' default script policy blocks.)

**2.2 [YOU · terminal]** In **your own PowerShell**, run each line. At the hidden prompt, paste:

| Secret | Value |
|---|---|
| `DATABRICKS_HOST` | host from 1.6 (no `https://`) |
| `DATABRICKS_WAREHOUSE_ID` | warehouse ID from 1.4 |
| `DATABRICKS_CLIENT_ID` | Application ID from 1.2 |
| `DATABRICKS_CLIENT_SECRET` | secret from 1.3 (from your password manager) |

On the first command, Wrangler asks for the value **first**, then says there's no Worker called `tmc-solutions-site` and
asks whether to create one. Answer **Y**. That creates an empty placeholder Worker to hold the secrets. Until Phase 3 replaces
it, the placeholder may briefly have a `*.workers.dev` URL; it serves nothing of yours. The Phase 3 deploy turns that URL off
(`workers_dev = false`) and attaches the real domains.

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

**3.0 Gate.** Confirm that the user replied "done" to **Phase 0.5** in this session. If they haven't, stop and ask. Don't deploy.

**3.1 [CLAUDE CODE]** (Bash tool timeout: 600000 ms)
```bash
npm run deploy
```
**Expect**, in order:
1. `# tests 21` and `# fail 0`
2. `--dry-run: exiting now.`
3. Upload summary, then a **Deployed tmc-solutions-site triggers** section listing
   `tmcsolutions-org.net (custom domain)` and `www.tmcsolutions-org.net (custom domain)`
4. A `Current Version ID: …`. Record it in your report to the user (it's the rollback target for the next deploy).

Wrangler will refuse to deploy if any secret is missing (`[secrets] required` in `wrangler.toml`). That's intended:
go back to Phase 2.

**3.2 [CLAUDE CODE] Wait for the certificate** (usually a few minutes). Run with a Bash tool timeout of 600000 ms:
```bash
for i in $(seq 1 36); do c=$(curl -s -o /dev/null -w '%{http_code}' https://tmcsolutions-org.net/); [ "$c" = 200 ] && { echo ready; break; }; sleep 15; done; echo "last=$c"
```
**Expect:** `ready`. If it prints only `last=<code>`, run the same command **once** more. If it still isn't ready after that
(~18 minutes total), stop and report using the "never reaches 200" row in Troubleshooting.

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

**If it returns 500:**
1. Start `npx wrangler tail --format pretty` as a **background** Bash task (`run_in_background: true`). A plain call blocks forever.
2. Wait until its output shows it is connected to `tmc-solutions-site`.
3. Wait 60 s (rate limit), then re-run the 4.2 curl **once**.
4. Read the `[tmc-lead-intake] write failed: …` line from the background task's output, then stop the task.
5. Match that line in **Troubleshooting** and report it to the user. Don't retry beyond this.

**4.3 [YOU · browser] Confirm the row landed.** Databricks SQL editor:
```sql
SELECT id, submitted_at, name, email, service, length(ip_hash) AS hash_len
FROM tmc_solutions_jvs.tmc_solutions.leads
ORDER BY submitted_at DESC LIMIT 5;
```
**Expect:** the "Deploy Smoke Test" row, `submitted_at` within the last few minutes (UTC), `hash_len` = 64. You can
delete the test row yourself later. (With the `INSERT` grant the service principal can't delete rows; with the `MODIFY`
fallback it could.)

**4.4 [YOU · browser] Real browser pass.** Open `https://tmcsolutions-org.net` in a private window. Confirm the page renders
(animations and counters run, and repo cards appear), then submit the form once with your own details. **Expect:** "Transmission
received…" and a second row in 4.3's query. Open `https://www.tmcsolutions-org.net` and confirm it renders too.

**4.5 [YOU · browser] Email records intact.** Cloudflare → **tmcsolutions-org.net** → **DNS** → **Records**. **Expect:**
every MX and TXT record you noted in 0.5 is still there, unchanged. Then send a test email to
`russ.meredith@tmcsolutions-org.net` from another account and confirm it arrives. If anything's missing, re-add it from your
0.5 notes before doing anything else.

**Production is done when 4.1–4.5 all pass.** Claude Code: report the version ID, the 4.1 table, and the 4.2 response.

---

## Phase 5 (optional): Matrix-Sans fonts

Until the font files exist, the page falls back to Courier New, then monospace. To add them:

1. **[YOU]** Check two things in your Matrix-Sans license: does it permit **web self-hosting**, and does it permit
   **redistribution in a public repository**? This repo is public on GitHub, so committing the files publishes them.
2. **[YOU]** Put the files in `public/fonts/` with **exactly** these names (whichever formats you have; `.woff2` matters most):
   `Matrix-Sans.woff2`, `Matrix-Sans.woff`, `Matrix-Sans.otf`, `Matrix-Sans-Bold.woff2`, `Matrix-Sans-Bold.woff`, `Matrix-Sans-Bold.otf`.
   Tell Claude Code which case applies: **"redistribution allowed"** or **"self-host only"**.
3. **[CLAUDE CODE]** (Bash tool timeout: 600000 ms) `npm run deploy`, then check that
   `curl -s -o /dev/null -w '%{http_code}' https://tmcsolutions-org.net/fonts/Matrix-Sans.woff2` returns `200`. Then:
   - **redistribution allowed:** `git add public/fonts && git commit -m "feat: add Matrix-Sans webfonts" && git push origin main`
   - **self-host only:** don't commit. Append the six filenames (as `public/fonts/<name>`) to `.git/info/exclude`, which is local
     and never pushed. Tell the user that every future deploy must run from this machine, and that the optional Workers
     Builds auto-deploy (Phase 6) would ship without the fonts.

---

## Phase 6: Operating it

| Task | How |
|---|---|
| **Change the page** | Edit `public/index.html`. If you touched anything inside `<script>…</script>`, run `npm run csp:update` (the CSP pins that script's hash; `npm test` fails if it's stale). Then `npm run deploy`, commit, and push. |
| **Roll back** | `npx wrangler deployments list` → `npx wrangler rollback <version-id>` (version from a previous Phase 3.1 report). This restores that version's **code, assets, and secret values**. In a non-interactive shell Wrangler doesn't stop to warn you when secrets changed since then. So if you've rotated a secret since that version, immediately re-run `npx.cmd wrangler secret put DATABRICKS_CLIENT_SECRET` (and any other rotated secret), then rerun Phase 4.2. |
| **Watch live errors** | `npx wrangler tail --format pretty`. Logs carry status codes and error codes only, never lead data. |
| **Rotate the OAuth secret** (yearly, before expiry) | Databricks: `tmc-lead-intake-sp` → **Secrets** → **Generate secret** → **[YOU · terminal]** `npx.cmd wrangler secret put DATABRICKS_CLIENT_SECRET` → rerun Phase 4.2 → then delete the **old** secret in Databricks. |
| **Suspected credential leak** | Deleting the secret alone isn't enough, because access tokens already issued (including the Worker's cached one) stay valid for up to 1 hour. Do all of these right away: (1) `REVOKE ALL PRIVILEGES ON TABLE tmc_solutions_jvs.tmc_solutions.leads FROM \`<application-id>\`;` (2) remove the SP's **Can use** on the warehouse; (3) delete the SP's secret. The form shows the "email us directly" fallback until you're done. Then review recent rows and Query History for the SP, generate a new secret, re-apply 1.4–1.5, `secret put` it, and rerun Phase 4.2. |
| **Narrow the OAuth scope** (optional hardening) | Databricks recommends against **all APIs**. To try a narrower scope: generate a new SP secret with only the SQL scope selected → `npx.cmd wrangler secret put DATABRICKS_CLIENT_SECRET` → change `DATABRICKS_OAUTH_SCOPE` in `wrangler.toml` to `sql` → `npm run deploy` → rerun Phase 4.2. If 4.2 fails with `token endpoint HTTP 400`, revert both. |
| **Auto-deploy on push** (optional) | Dashboard → **Workers & Pages** → `tmc-solutions-site` → **Settings** → **Builds** → **Connect** → repo `TMC-The-Meredith-Collective/Rtmc-siteR`, branch `main`, deploy command `npm run deploy`. Runtime secrets persist on the Worker and don't go into build settings. |
| **Redirect `www` → apex** (optional SEO polish) | Currently both hostnames serve the site, and `<link rel="canonical">` points search engines at the apex. To hard-redirect instead: dashboard → zone → **Rules** → **Redirect Rules** → template **Redirect from WWW to root** → Deploy. |

---

## Troubleshooting

| Symptom (where you see it) | Cause | Fix |
|---|---|---|
| `npm run deploy` → missing required secrets | Phase 2 incomplete | Phase 2.2 for the names `secret list` doesn't show |
| `npm run deploy` → authentication / "not logged in" | Wrangler session expired | `npx wrangler login`, then 3.1 |
| Phase 3 wait loop never reaches 200 | Certificate still issuing, or domain attached to another project | Dashboard → `tmc-solutions-site` → **Settings** → **Domains & Routes**: both domains present and **Active**? If they show "Pending", wait; if they're missing, recheck 0.5 |
| tail: `write failed: token endpoint HTTP 401` (or 400) | Wrong `DATABRICKS_CLIENT_ID` / `_SECRET`, or wrong host | Re-enter the three with `secret put` (2.2), then 4.2 |
| tail: `write failed: statements HTTP 403` | SP lacks **Can use** on the warehouse, or **Databricks SQL access** entitlement | 1.4 / 1.2 |
| tail: `write failed: statements HTTP 404` / `400` | Wrong `DATABRICKS_WAREHOUSE_ID` | Re-enter it (2.2) |
| tail: `statement FAILED <code>` (any code, e.g. `BAD_REQUEST`) | The SQL itself was rejected. The API's error code is generic, and the Worker deliberately doesn't log the message, because messages can echo values | **[YOU · browser]** Databricks → **Query History** → filter **User** = `tmc-lead-intake-sp` → open the failed INSERT and read its error. Permission/privilege errors → 1.5, and if `INSERT` was granted, apply the **MODIFY fallback**. Table/schema not found → `USE CATALOG`/`USE SCHEMA` grants (1.5), or create the table from `docs/leads-table.sql`. Then rerun 4.2 |
| tail: `statement CANCELED` | Warehouse cold start > 30 s | Use a Serverless warehouse (1.4), or start the warehouse and retry |
| tail: `token endpoint HTTP 400` right after narrowing the scope | Scope string not accepted for this secret | Revert `DATABRICKS_OAUTH_SCOPE` to `all-apis` (Phase 6 row) |
| Browser form says "Forbidden." | Page opened from a host not in `ALLOWED_ORIGINS` | Use `https://tmcsolutions-org.net` or `www`; don't use a raw IP or another domain |
| Browser form says "Too many requests" | 3 submissions per minute per IP | Wait 60 s |
| Page loads but is static (no counters or repo cards), console shows CSP "Refused to execute inline script" | Inline script edited without updating its hash | `npm run csp:update`, then `npm run deploy` |
