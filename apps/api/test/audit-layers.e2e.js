/* Pruebas de la API de la auditoría por capas: agentes asignados a una capa, presupuesto de IA, interruptores por repositorio y el
 * consumo que devuelve la página del commit.
 *
 * Uso (desde la raíz del repo, con postgres y api levantados; la prueba necesita JWT_SECRET en el contenedor):
 *   docker compose exec -T api node - < apps/api/test/audit-layers.e2e.js
 *
 * Crea una organización de prueba y la borra al terminar; restaura el presupuesto y deja los agentes como estaban. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000/api';
const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
const q = async (sql, params) => (await owner.query(sql, params)).rows;
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const suffix = crypto.randomBytes(3).toString('hex');
const randomIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
const call = async (path, cookie, { method = 'GET', body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: cookie ?? '', 'x-forwarded-for': randomIp(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // no JSON
  }
  return { status: res.status, json, text };
};
async function cookieFor(email, password) {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() }, body: JSON.stringify({ email, password }) });
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}

(async () => {
  const hash = await bcrypt.hash('Passw0rd!aud', 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Aud API', $1) RETURNING id`, [`audapi-${suffix}`]))[0].id;
  const mk = async (label, role) => {
    const email = `${label}-${suffix}@audapi.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return { email, id };
  };
  const admin = await mk('admin', 'admin');
  const user = await mk('user', 'user');
  const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 930000 + crypto.randomInt(1, 99999)]))[0].id;
  const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 980000 + crypto.randomInt(1, 99999)]))[0].id;
  const savedBudget = (await q('SELECT audit_monthly_budget_usd, audit_max_cost_per_audit_usd, audit_budget_policy FROM system_settings WHERE id = true'))[0];
  const createdProviders = [];

  try {
    const cAdmin = await cookieFor(admin.email, 'Passw0rd!aud');
    const cUser = await cookieFor(user.email, 'Passw0rd!aud');

    // ================================================================== presupuesto
    let r = await call('/system-settings/audit-budget', null);
    check('presupuesto: sin sesión → 401', r.status === 401);
    r = await call('/system-settings/audit-budget', cUser);
    check('presupuesto: un usuario que no es admin → 403', r.status === 403);
    r = await call('/system-settings/audit-budget', cAdmin);
    check('presupuesto: el admin lo ve con tarifas vigentes y el gasto del mes', r.status === 200 && typeof r.json.budget.monthlyUsd === 'number' && r.json.budget.policy && Array.isArray(r.json.prices) && r.json.prices.some((p) => p.model_key === 'gpt-5.6-luna' && p.inference === 'us') && typeof r.json.month.spentUsd === 'number' && typeof r.json.month.percentUsed === 'number', r.text.slice(0, 300));
    r = await call('/system-settings/audit-budget', cAdmin, { method: 'PATCH', body: { monthlyUsd: 50, perAuditUsd: '2,5', policy: 'block' } });
    check('presupuesto: guarda tope mensual de 50 USD, tope por auditoría (acepta coma decimal) y la política', r.status === 200 && r.json.budget.monthlyUsd === 50 && r.json.budget.perAuditUsd === 2.5 && r.json.budget.policy === 'block', r.text.slice(0, 200));
    check('presupuesto: queda en la base', (await q('SELECT audit_monthly_budget_usd::float AS m, audit_max_cost_per_audit_usd::float AS p, audit_budget_policy AS pol FROM system_settings WHERE id = true'))[0].p === 2.5);
    r = await call('/system-settings/audit-budget', cAdmin, { method: 'PATCH', body: { policy: 'partial' } });
    check('presupuesto: un cambio parcial no toca lo demás', r.status === 200 && r.json.budget.monthlyUsd === 50 && r.json.budget.perAuditUsd === 2.5 && r.json.budget.policy === 'partial');
    for (const [label, body] of [['negativo', { monthlyUsd: -1 }], ['texto', { monthlyUsd: 'mucho' }], ['enorme', { perAuditUsd: 1e9 }], ['política inválida', { policy: 'ignorar' }], ['NaN', { monthlyUsd: 'NaN' }]]) {
      r = await call('/system-settings/audit-budget', cAdmin, { method: 'PATCH', body });
      check(`presupuesto: valor inválido (${label}) → 400`, r.status === 400, String(r.status));
    }
    r = await call('/system-settings/audit-budget', cUser, { method: 'PATCH', body: { monthlyUsd: 1 } });
    check('presupuesto: un usuario que no es admin no puede cambiarlo → 403', r.status === 403);

    // el gasto del mes se suma de lo registrado
    const run = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision) VALUES ($1, $2, $3, 'push', 'completed', 'apto') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex')]))[0].id;
    const before = (await call('/system-settings/audit-budget', cAdmin)).json.month.spentUsd;
    await q(`INSERT INTO llm_invocations(organization_id, review_run_id, purpose, model, prompt_tokens, completion_tokens, cost_usd) VALUES ($1, $2, 'layer2', 'us.openai.gpt-5.6-luna', 1000, 100, 0.25), ($1, $2, 'review', 'us.openai.gpt-5.6-sol', 1000, 100, 0.75), ($1, $2, 'review', 'otro-modelo', 10, 1, NULL)`, [org, run]);
    r = await call('/system-settings/audit-budget', cAdmin);
    check('gasto del mes: suma los costos registrados, marca las llamadas sin tarifa y desglosa por propósito y modelo', Math.abs(r.json.month.spentUsd - before - 1) < 1e-6 && r.json.month.unpricedCalls >= 1 && r.json.month.breakdown.some((b) => b.purpose === 'layer2' && b.model === 'us.openai.gpt-5.6-luna'), r.text.slice(0, 300));
    r = await call(`/dashboard/review-runs/${run}`, cAdmin);
    check('la página del commit trae el consumo de IA de esa auditoría con su costo (null si no hay tarifa)', r.status === 200 && r.json.llm_invocations.length === 3 && r.json.llm_invocations.find((x) => x.purpose === 'layer2').cost_usd === 0.25 && r.json.llm_invocations.find((x) => x.model === 'otro-modelo').cost_usd === null && r.json.llm_invocations.find((x) => x.model === 'otro-modelo').unpriced === 1, r.text.slice(0, 300));
    check('y los campos de la capa 2 (vacíos si no corrió)', 'audit_layer2' in r.json && r.json.audit_layer2 === null && r.json.audit_escalation === null);

    // ================================================================== agentes por capa
    const llmBefore = (await call('/system-settings/llm', cAdmin)).json.providers.length;
    const mkProv = (body) => call('/system-settings/llm/providers', cAdmin, { method: 'POST', body: { kind: 'bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', apiKey: 'k', ...body } });
    r = await mkProv({ name: `Luna ${suffix}`, model: 'us.openai.gpt-5.6-luna', auditLayer: 'layer2' });
    const luna = r.json.providers.find((p) => p.name === `Luna ${suffix}`);
    if (luna) createdProviders.push(luna.id);
    check('agentes: se crea un agente asignado a la capa 2 y se devuelve su capa', r.status < 300 && luna?.auditLayer === 'layer2' && luna.kind === 'bedrock' && luna.apiKeySet === true && !r.text.includes('"apiKey"'), r.text.slice(0, 200));
    r = await mkProv({ name: `General ${suffix}`, model: 'us.openai.gpt-5.6-sol' });
    const sol = r.json.providers.find((p) => p.name === `General ${suffix}`);
    if (sol) createdProviders.push(sol.id);
    check('agentes: sin capa es un agente general (auditLayer null)', sol?.auditLayer === null);
    r = await mkProv({ name: `Mala ${suffix}`, model: 'x', auditLayer: 'capa9' });
    check('agentes: una capa inválida → 400 y no se crea', r.status === 400 && (await call('/system-settings/llm', cAdmin)).json.providers.length === llmBefore + 2);
    r = await call(`/system-settings/llm/providers/${sol.id}`, cAdmin, { method: 'PATCH', body: { auditLayer: 'layer3' } });
    check('agentes: se reasigna a la capa 3', r.json.providers.find((p) => p.id === sol.id).auditLayer === 'layer3');
    r = await call(`/system-settings/llm/providers/${sol.id}`, cAdmin, { method: 'PATCH', body: { name: `General2 ${suffix}` } });
    check('agentes: editar otro campo no cambia la capa asignada', r.json.providers.find((p) => p.id === sol.id).auditLayer === 'layer3');
    r = await call(`/system-settings/llm/providers/${sol.id}`, cAdmin, { method: 'PATCH', body: { auditLayer: 'general' } });
    check('agentes: "general" (o vacío) lo devuelve a la rotación general', r.json.providers.find((p) => p.id === sol.id).auditLayer === null);
    r = await call(`/system-settings/llm/providers/${sol.id}`, cAdmin, { method: 'PATCH', body: { auditLayer: 'layer2' } });
    r = await call(`/system-settings/llm/providers/${sol.id}`, cAdmin, { method: 'PATCH', body: { auditLayer: '' } });
    check('agentes: la cadena vacía también significa general', r.json.providers.find((p) => p.id === sol.id).auditLayer === null);
    r = await call(`/system-settings/llm/providers/${sol.id}`, cUser, { method: 'PATCH', body: { auditLayer: 'layer2' } });
    check('agentes: un usuario que no es admin no puede asignar capas → 403', r.status === 403);
    const ids = (await call('/system-settings/llm', cAdmin)).json.providers.map((p) => p.id);
    r = await call('/system-settings/llm/order', cAdmin, { method: 'PUT', body: { ids: [...ids].reverse() } });
    check('agentes: reordenar sigue funcionando con agentes de capa en la lista', r.status < 300 && r.json.providers[0].id === ids.at(-1));

    // ================================================================== interruptores por repositorio
    const settings = () => call(`/dashboard/repositories/${repo}/settings`, cAdmin);
    r = await settings();
    check('repo: la capa 1 y la 2 vienen apagadas por defecto', r.json.audit_layer1 === false && r.json.audit_layer2 === false);
    r = await call(`/dashboard/repositories/${repo}/settings`, cAdmin, { method: 'PATCH', body: { auditLayer2: true } });
    check('repo: activar la capa 2 sin la capa 1 → 400', r.status === 400 && /requiere la capa 1/.test(r.text));
    r = await call(`/dashboard/repositories/${repo}/settings`, cAdmin, { method: 'PATCH', body: { auditLayer2: 'si' } });
    check('repo: valor que no es booleano → 400', r.status === 400);
    r = await call(`/dashboard/repositories/${repo}/settings`, cAdmin, { method: 'PATCH', body: { auditLayer1: true, auditLayer2: true } });
    check('repo: activar ambas a la vez funciona', r.status < 300 && r.json.audit_layer1 === true && r.json.audit_layer2 === true, r.text.slice(0, 200));
    r = await call(`/dashboard/repositories/${repo}/settings`, cAdmin, { method: 'PATCH', body: { analysisDepth: 'deep' } });
    check('repo: cambiar otra opción no toca las capas', r.json.audit_layer1 === true && r.json.audit_layer2 === true && r.json.analysis_depth === 'deep');
    r = await call(`/dashboard/repositories/${repo}/settings`, cAdmin, { method: 'PATCH', body: { auditLayer1: false } });
    check('repo: apagar la capa 1 apaga también la capa 2', r.json.audit_layer1 === false && r.json.audit_layer2 === false);
    r = await call(`/dashboard/repositories/${repo}/settings`, cUser, { method: 'PATCH', body: { auditLayer1: true } });
    check('repo: un usuario que no es admin no puede cambiar las capas → 403', r.status === 403);
  } finally {
    for (const id of createdProviders) await q('DELETE FROM llm_providers WHERE id = $1', [id]);
    await q(`UPDATE llm_providers p SET position = r.pos FROM (SELECT id, row_number() OVER (ORDER BY position, created_at) AS pos FROM llm_providers) r WHERE p.id = r.id`);
    await q('DELETE FROM llm_invocations WHERE organization_id = $1', [org]);
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@audapi.test`]);
    await q(`UPDATE system_settings SET audit_monthly_budget_usd = $1, audit_max_cost_per_audit_usd = $2, audit_budget_policy = $3 WHERE id = true`, [savedBudget.audit_monthly_budget_usd, savedBudget.audit_max_cost_per_audit_usd, savedBudget.audit_budget_policy]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
