/**
 * Cloudflare Worker — tmc-lead-intake
 *
 * Accepts POST from the TMC landing page and writes securely to Databricks.
 *
 * Required Wrangler secrets / env vars:
 *   DATABRICKS_HOST          e.g. adb-XXXX.XX.azuredatabricks.net
 *   DATABRICKS_TOKEN         Personal Access Token (store as secret, never commit)
 *   DATABRICKS_WAREHOUSE_ID  SQL warehouse ID
 *   ALLOWED_ORIGIN           https://tmcsolutions-org.net
 *
 * Required KV namespace binding (wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "RATE_LIMIT_KV"
 *   id      = "<your kv namespace id>"
 */

const MAX_BODY_BYTES  = 8_192;   // 8 KB hard cap
const RL_WINDOW_SEC   = 60;      // rate-limit window
const RL_MAX_HITS     = 3;       // max submissions per IP per window

export default {
  async fetch(request, env, ctx) {

    // ── CORS preflight ─────────────────────────────
    if (request.method === 'OPTIONS') {
      return buildCors(new Response(null, { status: 204 }), env.ALLOWED_ORIGIN);
    }

    // ── Method gate ────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ── Origin enforcement ─────────────────────────
    const origin = request.headers.get('Origin') ?? '';
    if (origin !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── Content-Type gate ──────────────────────────
    const ct = request.headers.get('Content-Type') ?? '';
    if (!ct.includes('application/json')) {
      return json({ message: 'Content-Type must be application/json.' }, 415, env);
    }

    // ── Body size guard ────────────────────────────
    const cl = parseInt(request.headers.get('Content-Length') ?? '0', 10);
    if (cl > MAX_BODY_BYTES) {
      return json({ message: 'Payload too large.' }, 413, env);
    }

    // ── Rate limiting (Cloudflare KV) ──────────────
    const ip       = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipHash   = await sha256(ip);                       // never store raw IP
    const window   = Math.floor(Date.now() / (RL_WINDOW_SEC * 1000));
    const rlKey    = `rl:${ipHash}:${window}`;
    const hits     = parseInt((await env.RATE_LIMIT_KV.get(rlKey)) ?? '0', 10);

    if (hits >= RL_MAX_HITS) {
      return json({ message: 'Too many requests. Please wait and try again.' }, 429, env);
    }
    // Increment asynchronously — don't block the response
    ctx.waitUntil(
      env.RATE_LIMIT_KV.put(rlKey, String(hits + 1), { expirationTtl: RL_WINDOW_SEC * 2 })
    );

    // ── Parse body ─────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ message: 'Invalid JSON.' }, 400, env);
    }

    // ── Field extraction & validation ──────────────
    const { name, email, company = '', phone = '', service = '', budget = '', message } = body;

    if (!name || !email || !message) {
      return json({ message: 'Required fields missing.' }, 400, env);
    }

    // Basic email format (belt-and-suspenders; client already validates)
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) {
      return json({ message: 'Invalid email address.' }, 400, env);
    }

    // ── Sanitize: strip control chars, limit lengths ─
    const clean = s => String(s ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim();
    const rec = {
      name:     clean(name).slice(0, 128),
      email:    clean(email).slice(0, 254),
      company:  clean(company).slice(0, 256),
      phone:    clean(phone).slice(0, 32),
      service:  clean(service).slice(0, 128),
      budget:   clean(budget).slice(0, 64),
      message:    clean(message).slice(0, 2_000),
      ip_hash:    ipHash,     // SHA-256 of raw IP — privacy-safe
      user_agent: (request.headers.get('User-Agent') ?? '').slice(0, 512)
    };

    // ── Write to Databricks ────────────────────────
    try {
      await writeLead(rec, env);
    } catch (err) {
      console.error('[tmc-lead-intake] Databricks error:', err.message);
      return json({ message: 'Internal error. Please email russ.meredith@tmcsolutions-org.net directly.' }, 500, env);
    }

    return json({ ok: true }, 200, env);
  }
};

/* ── Databricks SQL Statement Execution API ───── */
async function writeLead(rec, env) {
  // Parameterised INSERT — no string interpolation, no SQL injection surface
  // submitted_at supplied inline as CURRENT_TIMESTAMP() — no DEFAULT feature flag needed
  const statement = `
    INSERT INTO tmc_solutions_jvs.tmc_solutions.leads
      (submitted_at, name, email, company, phone, service, budget, message, ip_hash, user_agent)
    VALUES
      (CURRENT_TIMESTAMP(), :name, :email, :company, :phone, :service, :budget, :message, :ip_hash, :user_agent)
  `;

  const parameters = [
    { name: 'name',       value: rec.name,       type: 'STRING' },
    { name: 'email',      value: rec.email,       type: 'STRING' },
    { name: 'company',    value: rec.company,     type: 'STRING' },
    { name: 'phone',      value: rec.phone,       type: 'STRING' },
    { name: 'service',    value: rec.service,     type: 'STRING' },
    { name: 'budget',     value: rec.budget,      type: 'STRING' },
    { name: 'message',    value: rec.message,     type: 'STRING' },
    { name: 'ip_hash',    value: rec.ip_hash,     type: 'STRING' },
    { name: 'user_agent', value: rec.user_agent,  type: 'STRING' }
  ];

  const endpoint = `https://${env.DATABRICKS_HOST}/api/2.0/sql/statements`;

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${env.DATABRICKS_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      warehouse_id:    env.DATABRICKS_WAREHOUSE_ID,
      statement,
      parameters,
      wait_timeout:    '10s',
      on_wait_timeout: 'CANCEL'
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const result = await res.json();
  if (result.status?.state === 'FAILED') {
    throw new Error(`Statement FAILED: ${result.status.error?.message ?? 'unknown'}`);
  }
}

/* ── Helpers ─────────────────────────────────── */
function json(body, status, env) {
  return buildCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    }),
    env?.ALLOWED_ORIGIN
  );
}

function buildCors(response, origin) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin',  origin ?? '*');
  r.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  r.headers.set('X-Content-Type-Options',       'nosniff');
  r.headers.set('X-Frame-Options',              'DENY');
  r.headers.set('Referrer-Policy',              'strict-origin-when-cross-origin');
  return r;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
