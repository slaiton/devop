/* Pruebas de la API del análisis profundo: el selector estándar/profundo por repositorio
 * (GET/PATCH /dashboard/repositories/:id/settings) y los datos de cómo se analizó cada commit
 * (GET /dashboard/review-runs/:id). La parte del worker está en apps/worker/test/deep-analysis.test.js.
 *
 * Uso (desde la raíz del repo, con postgres y api levantados):
 *   docker compose exec -T api node - < apps/api/test/deep-analysis.e2e.js
 *
 * Crea una organización de prueba y la borra al terminar. */
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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
const api = async (path, cookie, { method = 'GET', body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: cookie ?? '', 'x-forwarded-for': randomIp(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
async function cookieFor(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}

(async () => {
  const hash = await bcrypt.hash('Passw0rd!deep', 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Deep', $1) RETURNING id`, [`deep-${suffix}`]))[0].id;
  const mkUser = async (label, role) => {
    const email = `${label}-${suffix}@deep.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return { email, id };
  };
  const admin = await mkUser('admin', 'admin');
  const user = await mkUser('user', 'user');
  const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 910000 + crypto.randomInt(1, 99999)]))[0].id;
  const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 960000 + crypto.randomInt(1, 99999)]))[0].id;
  await q('INSERT INTO repository_members(organization_id, repository_id, user_id) VALUES ($1, $2, $3)', [org, repo, user.id]).catch(() => undefined);

  const trace = [
    { round: 1, tool: 'search_code', args: { pattern: 'findByEmail' }, ok: true, summary: '2 coincidencias en 2 archivos', chars: 300, ms: 40 },
    { round: 2, tool: 'read_file', args: { path: 'src/a.ts', start_line: 1, end_line: 40 }, ok: true, summary: 'src/a.ts líneas 1-40 de 120', chars: 2100, ms: 8 },
  ];
  const stats = { rounds: 3, toolCalls: 2, promptTokens: 9000, completionTokens: 800, durationMs: 21000, budgetExhausted: false };
  const deepRun = (await q(
    `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, quality_score, risk_level, analysis_mode, analysis_trace, analysis_stats)
     VALUES ($1, $2, $3, 'push', 'completed', 80, 'low', 'deep', $4, $5) RETURNING id`,
    [org, repo, 'a'.repeat(40), JSON.stringify(trace), JSON.stringify(stats)],
  ))[0].id;
  const fallbackRun = (await q(
    `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, analysis_mode, analysis_note)
     VALUES ($1, $2, $3, 'push', 'completed', 'standard', 'El modelo configurado no soporta herramientas') RETURNING id`,
    [org, repo, 'b'.repeat(40)],
  ))[0].id;
  const oldRun = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status) VALUES ($1, $2, $3, 'push', 'completed') RETURNING id`, [org, repo, 'c'.repeat(40)]))[0].id;

  try {
    const adminCookie = await cookieFor(admin.email, 'Passw0rd!deep');
    const userCookie = await cookieFor(user.email, 'Passw0rd!deep');
    check('login de prueba', !!adminCookie && !!userCookie);

    let r = await api(`/dashboard/repositories/${repo}/settings`, adminCookie);
    check('un repo sin configuración explícita está en análisis estándar', r.status === 200 && r.json.analysis_depth === 'standard', JSON.stringify(r.json));

    r = await api(`/dashboard/repositories/${repo}/settings`, adminCookie, { method: 'PATCH', body: { analysisDepth: 'deep' } });
    check('el admin puede pasar el repo a análisis profundo', r.status === 200 && r.json.analysis_depth === 'deep', JSON.stringify(r.json));
    check('y queda guardado en la configuración del repo', (await q('SELECT analysis_depth FROM quality_gate_configs WHERE repository_id = $1', [repo]))[0].analysis_depth === 'deep');

    r = await api(`/dashboard/repositories/${repo}/settings`, adminCookie, { method: 'PATCH', body: { notifyAuthorOnPush: false } });
    check('cambiar otros ajustes no revierte la profundidad', r.json.analysis_depth === 'deep' && r.json.notify_author_on_push === false);

    r = await api(`/dashboard/repositories/${repo}/settings`, adminCookie, { method: 'PATCH', body: { analysisDepth: 'standard' } });
    check('se puede volver a estándar', r.json.analysis_depth === 'standard');

    r = await api(`/dashboard/repositories/${repo}/settings`, adminCookie, { method: 'PATCH', body: { analysisDepth: 'turbo' } });
    check('un valor inválido → 400', r.status === 400, JSON.stringify(r));
    check('y no cambia lo guardado', (await q('SELECT analysis_depth FROM quality_gate_configs WHERE repository_id = $1', [repo]))[0].analysis_depth === 'standard');

    r = await api(`/dashboard/repositories/${repo}/settings`, userCookie, { method: 'PATCH', body: { analysisDepth: 'deep' } });
    check('un usuario no admin no puede cambiarla → 403', r.status === 403);

    r = await api(`/dashboard/review-runs/${deepRun}`, adminCookie);
    check('el commit analizado en profundo expone modo, traza y consumo', r.status === 200 && r.json.analysis_mode === 'deep' && r.json.analysis_trace.length === 2 && r.json.analysis_trace[0].tool === 'search_code' && r.json.analysis_stats.promptTokens === 9000 && r.json.analysis_note === null, JSON.stringify(r.json).slice(0, 300));
    r = await api(`/dashboard/review-runs/${fallbackRun}`, adminCookie);
    check('un commit que cayó a estándar expone el motivo', r.json.analysis_mode === 'standard' && /no soporta herramientas/.test(r.json.analysis_note) && r.json.analysis_trace === null);
    r = await api(`/dashboard/review-runs/${oldRun}`, adminCookie);
    check('un commit anterior a esta función no tiene modo (la UI no muestra el panel)', r.status === 200 && r.json.analysis_mode === null && r.json.analysis_trace === null);
  } finally {
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@deep.test`]);
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
