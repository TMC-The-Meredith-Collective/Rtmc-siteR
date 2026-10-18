# tmcsolutions-site

Static site for tmcsolutions-org.net. No build step.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Home: mission, record, pillars, contact |
| `jobs.html` | Job search page; Careerjet partner snippet goes in `#careerjet-results` |
| `styles.css` | Shared styles |
| `_headers` | Cloudflare Pages response headers |

## Deploy (Cloudflare Pages, Git-connected)

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create application → Pages → Import an existing Git repository.
3. Select the repo. Framework preset: None. Build command: empty. Build output directory: `/`.
4. Save and Deploy. Verify on the `*.pages.dev` URL.
5. Custom domains → add `tmcsolutions-org.net` and `www.tmcsolutions-org.net`. DNS records are created automatically because the zone is on the same account.

Every push to `main` redeploys. Preview deployments are created for other branches.

## Before publishing

- Confirm `russ.meredith@tmcsolutions-org.net` routes (Cloudflare Email Routing).
- Footer shows "TMC Solutions" until the LLC filing completes; the legal-name line is commented in `index.html`.
- Paste the Careerjet partner snippet into `jobs.html` after the affid is issued.
