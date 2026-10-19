/**
 * Cloudflare Worker — tmc-lead-intake
 *
 * One Worker serves tmcsolutions-org.net:
 *   • Static assets in ./public are served by Cloudflare directly (asset-first;
 *     this script is NOT invoked for them — see wrangler.toml [assets]).
 *   • Requests that match no asset reach this script. Only POST /api/submit is handled;
 *     everything else is 404/405.
 *
 * Lead path: Origin allowlist → Content-Type → size cap → rate limit → validate →
 *            sanitize → OAuth M2M token → parameterized INSERT via Databricks SQL
 *            Statement Execution API.
 *
 * Bindings / config (see wrangler.toml):
 *   ALLOWED_ORIGINS            [vars]   comma-separated exact origins
 *   DATABRICKS_OAUTH_SCOPE     [vars]   OAuth scope requested (default "all-apis")
 *   DATABRICKS_HOST            SECRET   workspace host, no scheme
 *   DATABRICKS_WAREHOUSE_ID    SECRET   SQL warehouse ID
 *   DATABRICKS_CLIENT_ID       SECRET   service principal application ID
 *   DATABRICKS_CLIENT_SECRET   SECRET   service principal OAuth secret
 *   LEAD_LIMITER               [[ratelimits]] binding
 */

const TABLE           = 'tmc_solutions_jvs.tmc_solutions.leads';
const SUBMIT_PATH     = '/api/submit';
const MAX_BODY_BYTES  = 8_192;
const TOKEN_SKEW_MS   = 60_000;   // refresh token 60s before expiry
const SERVICES        = new Set([
  'owner-operator', 'growing-business', 'developer-collab', 'investor-partner', 'other'
]);

/* Module-scope token cache: lives for the isolate's lifetime, never persisted. */
let tokenCache = { value: null, expiresAt: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== SUBMIT_PATH) {
      return json({ message: 'Not found.' }, 404);
    }
    if (request.method !== 'POST') {
      return json({ message: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }

    // ── Origin allowlist (same-origin POSTs always carry Origin) ──
    const allowed = String(env.ALLOWED_ORIGINS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') ?? '';
    if (!allowed.includes(origin)) {
      return json({ message: 'Forbidden.' }, 403);
    }

    if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return json({ message: 'Content-Type must be application/json.' }, 415);
    }

    // ── Size cap: enforce on the bytes actually read, not on a client-supplied header ──
    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (declared > MAX_BODY_BYTES) return json({ message: 'Payload too large.' }, 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ message: 'Payload too large.' }, 413);
    }

    // ── Rate limit per hashed IP (raw IP is never stored or sent anywhere) ──
    const ipHash = await sha256(request.headers.get('CF-Connecting-IP') ?? 'unknown');
    const { success } = await env.LEAD_LIMITER.limit({ key: `submit:${ipHash}` });
    if (!success) {
      return json({ message: 'Too many requests. Please wait a minute and try again.' }, 429);
    }

    let body;
    try { body = JSON.parse(raw); } catch { return json({ message: 'Invalid JSON.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ message: 'Invalid JSON.' }, 400);
    }

    const clean = s => String(s ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim();
    const rec = {
      name:       clean(body.name).slice(0, 128),
      email:      clean(body.email).slice(0, 254),
      company:    clean(body.company).slice(0, 256),
      phone:      clean(body.phone).slice(0, 32),
      service:    clean(body.service).slice(0, 128),
      budget:     clean(body.budget).slice(0, 64),
      message:    clean(body.message).slice(0, 2_000),
      ip_hash:    ipHash,
      user_agent: clean(request.headers.get('User-Agent')).slice(0, 512)
    };

    if (!rec.name || !rec.email || !rec.message) {
      return json({ message: 'Required fields missing.' }, 400);
    }
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(rec.email)) {
      return json({ message: 'Invalid email address.' }, 400);
    }
    if (rec.service && !SERVICES.has(rec.service)) {
      return json({ message: 'Invalid selection.' }, 400);
    }

    try {
      await writeLead(rec, env);
    } catch (err) {
      // Log status/error_code only — never request values (PII) or credentials.
      console.error('[tmc-lead-intake] write failed:', err.message);
      return json({ message: 'Internal error. Please email russ.meredith@tmcsolutions-org.net directly.' }, 500);
    }

    return json({ ok: true }, 200);
  }
};

/* ── Databricks OAuth M2M (client credentials) ───────────────────────────── */
async function getAccessToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - TOKEN_SKEW_MS) {
    return tokenCache.value;
  }
  const res = await fetch(`https://${env.DATABRICKS_HOST}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${env.DATABRICKS_CLIENT_ID}:${env.DATABRICKS_CLIENT_SECRET}`),
      'Content-Type':  'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: env.DATABRICKS_OAUTH_SCOPE || 'all-apis'
    }).toString()
  });
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('token endpoint returned no access_token');
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000
  };
  return tokenCache.value;
}

/* ── Parameterized INSERT — values travel only as typed parameters ───────── */
async function writeLead(rec, env) {
  const statement = `
    INSERT INTO ${TABLE}
      (submitted_at, name, email, company, phone, service, budget, message, ip_hash, user_agent)
    VALUES
      (CURRENT_TIMESTAMP(), :name, :email, :company, :phone, :service, :budget, :message, :ip_hash, :user_agent)
  `;
  const parameters = ['name', 'email', 'company', 'phone', 'service', 'budget', 'message', 'ip_hash', 'user_agent']
    .map(name => ({ name, value: rec[name], type: 'STRING' }));

  const token = await getAccessToken(env);
  const res = await fetch(`https://${env.DATABRICKS_HOST}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id:    env.DATABRICKS_WAREHOUSE_ID,
      statement,
      parameters,
      wait_timeout:    '30s',      // covers a serverless warehouse cold start
      on_wait_timeout: 'CANCEL'    // fail loudly to the visitor rather than lose the lead silently
    })
  });

  if (res.status === 401 || res.status === 403) tokenCache = { value: null, expiresAt: 0 };
  if (!res.ok) throw new Error(`statements HTTP ${res.status}`);

  const result = await res.json();
  const state = result.status?.state;
  if (state !== 'SUCCEEDED') {
    throw new Error(`statement ${state ?? 'UNKNOWN'} ${result.status?.error?.error_code ?? ''}`.trim());
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':           'application/json; charset=utf-8',
      'Cache-Control':          'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options':        'DENY',
      'Referrer-Policy':        'strict-origin-when-cross-origin',
      ...extra
    }
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Test-only hook: lets the suite isolate the module-scope token cache. */
export const __test = {
  resetTokenCache() { tokenCache = { value: null, expiresAt: 0 }; }
};
