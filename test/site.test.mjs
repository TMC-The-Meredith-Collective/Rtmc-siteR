// Static-site guards: CSP hash drift, placeholders, and form↔API contract. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inlineScriptHash } from '../scripts/csp-update.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

test('public/index.html and _headers use LF line endings (CRLF changes the CSP hash)', () => {
  assert.ok(!html.includes('\r'), 'public/index.html has CRLF — see runbook 0.2 (line-ending check)');
  assert.ok(!headers.includes('\r'), 'public/_headers has CRLF — see runbook 0.2 (line-ending check)');
});

test('exactly one inline <script> and no inline event handlers', () => {
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('_headers CSP allows exactly the current inline script hash (run `npm run csp:update` after editing it)', () => {
  assert.ok(headers.includes(`'${inlineScriptHash(html)}'`),
    'CSP hash is stale — run: npm run csp:update');
});

test('every font file in public/fonts is referenced by an @font-face url()', () => {
  const dir = new URL('../public/fonts/', import.meta.url);
  const fonts = readdirSync(dir).filter(f => /\.(woff2?|otf|ttf)$/i.test(f));
  for (const f of fonts) {
    assert.ok(html.includes(`url('/fonts/${f}')`), `public/fonts/${f} is not referenced in index.html @font-face — it will never load`);
  }
});

test('no unfilled placeholders remain', () => {
  assert.doesNotMatch(html, /YOUR_[A-Z_]+/);
});

test('form posts same-origin to /api/submit with the field names the Worker reads', () => {
  assert.match(html, /const ENDPOINT\s*=\s*'\/api\/submit'/);
  assert.match(html, /service:\s*form\.elements\.intent\.value/);
  assert.doesNotMatch(html, /\bts:\s*new Date/);
});
