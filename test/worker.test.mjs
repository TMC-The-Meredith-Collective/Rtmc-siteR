// Contract tests for the lead-intake Worker. Run: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { __test } from '../worker/tmc-lead-intake-worker.js';

const APEX = 'https://tmcsolutions-org.net';
const WWW  = 'https://www.tmcsolutions-org.net';
const TABLE = 'tmc_solutions_jvs.tmc_solutions.tmc_site_leads';

let calls;          // outbound fetches captured
let dbxResponse;    // what the statement endpoint returns
let limiterOk;      // rate-limit verdict

function makeEnv(overrides = {}) {
  return {
    DATABRICKS_HOST: 'dbc-test.cloud.databricks.com',
    DATABRICKS_WAREHOUSE_ID: 'wh-123',
    DATABRICKS_CLIENT_ID: 'client-abc',
    DATABRICKS_CLIENT_SECRET: 'secret-xyz',
    DATABRICKS_OAUTH_SCOPE: 'all-apis',
    ALLOWED_ORIGINS: `${APEX},${WWW}`,
    LEAD_LIMITER: { limit: async () => ({ success: limiterOk }) },
    ...overrides
  };
}

const ctx = { waitUntil() {} };

function req({ method = 'POST', path = '/api/submit', origin = APEX,
               type = 'application/json', body, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip, 'User-Agent': 'node-test' };
  if (origin) headers.Origin = origin;
  if (type) headers['Content-Type'] = type;
  return new Request(`${APEX}${path}`, {
    method, headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {}))
  });
}

const valid = {
  name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines',
  service: 'growing-business', message: 'Need back-office automation.'
};

beforeEach(() => {
  calls = [];
  limiterOk = true;
  dbxResponse = { status: { state: 'SUCCEEDED' } };
  __test.resetTokenCache();
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/oidc/v1/token')) {
      return Response.json({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).endsWith('/api/2.0/sql/statements')) {
      return Response.json(dbxResponse);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

const dbxCalls = () => calls.filter(c => c.url.endsWith('/api/2.0/sql/statements'));
const tokenCalls = () => calls.filter(c => c.url.endsWith('/oidc/v1/token'));

test('non-POST on /api/submit → 405', async () => {
  const res = await worker.fetch(req({ method: 'GET' }), makeEnv(), ctx);
  assert.equal(res.status, 405);
});

test('unknown path → 404 and no outbound calls', async () => {
  const res = await worker.fetch(req({ path: '/api/other', body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('foreign Origin → 403', async () => {
  const res = await worker.fetch(req({ origin: 'https://evil.example', body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('missing Origin → 403', async () => {
  const res = await worker.fetch(req({ origin: null, body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 403);
});

test('www origin is accepted', async () => {
  const res = await worker.fetch(req({ origin: WWW, body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 200);
});

test('wrong Content-Type → 415', async () => {
  const res = await worker.fetch(req({ type: 'text/plain', body: 'x' }), makeEnv(), ctx);
  assert.equal(res.status, 415);
});

test('oversized body without Content-Length is still rejected → 413', async () => {
  const big = JSON.stringify({ ...valid, message: 'a'.repeat(9_000) });
  const res = await worker.fetch(req({ body: big }), makeEnv(), ctx);
  assert.equal(res.status, 413);
  assert.equal(dbxCalls().length, 0);
});

test('rate-limited → 429 and Databricks never called', async () => {
  limiterOk = false;
  const res = await worker.fetch(req({ body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);
});

test('invalid JSON → 400', async () => {
  const res = await worker.fetch(req({ body: '{not json' }), makeEnv(), ctx);
  assert.equal(res.status, 400);
});

test('missing required field → 400', async () => {
  const { message, ...rest } = valid;
  const res = await worker.fetch(req({ body: rest }), makeEnv(), ctx);
  assert.equal(res.status, 400);
});

test('invalid email → 400', async () => {
  const res = await worker.fetch(req({ body: { ...valid, email: 'not-an-email' } }), makeEnv(), ctx);
  assert.equal(res.status, 400);
});

test('service outside allowlist → 400', async () => {
  const res = await worker.fetch(req({ body: { ...valid, service: '<script>' } }), makeEnv(), ctx);
  assert.equal(res.status, 400);
  assert.equal(dbxCalls().length, 0);
});

test('happy path: OAuth M2M token, parameterized INSERT, hashed IP', async () => {
  const res = await worker.fetch(req({ body: { ...valid, name: 'Ada\u0000 Lovelace' } }), makeEnv(), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // Token request: Basic client_id:client_secret, client_credentials grant
  const [tok] = tokenCalls();
  assert.equal(tok.url, 'https://dbc-test.cloud.databricks.com/oidc/v1/token');
  assert.equal(tok.init.method, 'POST');
  const basic = 'Basic ' + Buffer.from('client-abc:secret-xyz').toString('base64');
  assert.equal(new Headers(tok.init.headers).get('Authorization'), basic);
  const form = new URLSearchParams(String(tok.init.body));
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'all-apis');

  // Statement request: Bearer token from exchange, never the client secret
  const [stmt] = dbxCalls();
  assert.equal(new Headers(stmt.init.headers).get('Authorization'), 'Bearer tok-1');
  const payload = JSON.parse(stmt.init.body);
  assert.equal(payload.warehouse_id, 'wh-123');
  assert.match(payload.statement, new RegExp(`INSERT INTO ${TABLE.replace(/\./g, '\\.')}`));
  assert.match(payload.statement, /CURRENT_TIMESTAMP\(\)/);
  assert.doesNotMatch(payload.statement, /Ada|example\.com/, 'values must be parameters, not interpolated');

  const p = Object.fromEntries(payload.parameters.map(x => [x.name, x.value]));
  assert.deepEqual(Object.keys(p).sort(),
    ['budget', 'company', 'email', 'ip_hash', 'message', 'name', 'phone', 'service', 'user_agent']);
  assert.equal(p.name, 'Ada Lovelace', 'control chars stripped');
  assert.equal(p.service, 'growing-business');
  assert.equal(p.ip_hash, createHash('sha256').update('203.0.113.7').digest('hex'));
  assert.ok(!JSON.stringify(payload).includes('203.0.113.7'), 'raw IP never leaves the Worker');
});

test('access token is cached across requests', async () => {
  await worker.fetch(req({ body: valid }), makeEnv(), ctx);
  await worker.fetch(req({ body: valid }), makeEnv(), ctx);
  assert.equal(tokenCalls().length, 1);
  assert.equal(dbxCalls().length, 2);
});

test('Databricks failure → 500 with generic message, no internals leaked', async () => {
  dbxResponse = { status: { state: 'FAILED', error: { error_code: 'PERMISSION_DENIED', message: 'User sp-123 lacks INSERT on tmc_site_leads' } } };
  const res = await worker.fetch(req({ body: valid }), makeEnv(), ctx);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /PERMISSION|sp-123|tmc_site_leads/);
});

test('API responses are no-store, nosniff, and carry no CORS grant', async () => {
  const res = await worker.fetch(req({ body: valid }), makeEnv(), ctx);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});
