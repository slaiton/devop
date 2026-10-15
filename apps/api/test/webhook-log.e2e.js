/* Pruebas de punta a punta del registro de entregas de webhooks (tabla webhook_deliveries y
 * endpoints /webhook-log) contra una API en marcha.
 *
 * Uso (desde la raíz del repo, con postgres, redis y api levantados, y la API con
 * CONFIG_ENCRYPTION_KEY definida — hace falta para guardar el secret de la App de prueba):
 *   docker compose exec -T -e CONFIG_ENCRYPTION_KEY=<la misma que usa la api> api node - < apps/api/test/webhook-log.e2e.js
 *
 * Crea organizaciones/Apps de prueba y las borra al terminar. */
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { encrypt } = require('@devsentinel/settings');

const BASE = 'http://localhost:3000/api';
const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
const q = async (sql, params) => (await owner.query(sql, params)).rows;

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};

const suffix = crypto.randomBytes(3).toString('hex');
const SECRET = 'whsec-' + suffix;
const APP_ID = String(700000 + crypto.randomInt(1, 99999));
const randomIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;

async function hook(event, payload, { appId = APP_ID, secret = SECRET, form = false, sign = true } = {}) {
  const body = form ? `payload=${encodeURIComponent(JSON.stringify(payload))}` : JSON.stringify(payload);
  const headers = {
    'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
    'x-github-event': event,
    'x-github-delivery': crypto.randomUUID(),
    'user-agent': 'GitHub-Hookshot/e2e',
  };
  if (appId) headers['x-github-hook-installation-target-id'] = appId;
  if (sign) headers['x-hub-signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${BASE}/webhooks/github`, { method: 'POST', headers, body });
  return { status: res.status, guid: headers['x-github-delivery'] };
}

const REPO = { id: 880000 + crypto.randomInt(1, 99999), full_name: `acme-${suffix}/demo`, default_branch: 'main', owner: { login: `acme-${suffix}` } };
const push = (sha, ref) => ({
  ref,
  after: sha,
  installation: { id: 600000 + crypto.randomInt(1, 99999) },
  repository: REPO,
  head_commit: { author: { name: 'Dev', email: 'dev@acme.test' } },
});
const sha = (c) => c.repeat(40);

async function cookieFor(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}
const api = async (path, cookie, method = 'GET') => {
  const res = await fetch(BASE + path, { method, headers: { cookie: cookie ?? '', 'x-forwarded-for': randomIp() } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const rowFor = async (guid) => (await q('SELECT * FROM webhook_deliveries WHERE delivery_guid = $1', [guid]))[0];

(async () => {
  const hashPw = await bcrypt.hash('Passw0rd!log', 10);
  const orgA = (await q(`INSERT INTO organizations(name, slug) VALUES ('Log A', $1) RETURNING id`, [`log-a-${suffix}`]))[0].id;
  const orgB = (await q(`INSERT INTO organizations(name, slug) VALUES ('Log B', $1) RETURNING id`, [`log-b-${suffix}`]))[0].id;
  const mkUser = async (label, org, role) => {
    const email = `${label}-${suffix}@log.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hashPw]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return email;
  };
  const adminEmail = await mkUser('admin', orgA, 'admin');
  const userEmail = await mkUser('user', orgA, 'user');
  const mkApp = async (org, appId, secret, name) =>
    (await q(
      `INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
       VALUES ($1, $2, $3, $4, 'cid', $5, $5, $6) RETURNING id`,
      [org, name, appId, `slug-${appId}`, encrypt('x'), encrypt(secret)],
    ))[0].id;
  const appRow = await mkApp(orgA, APP_ID, SECRET, 'Secundaria');
  const appRowB = await mkApp(orgB, String(800000 + crypto.randomInt(1, 99999)), 'otro-secreto', 'App de otra org');

  // ===== entregas aceptadas / ignoradas =====
  let r = await hook('ping', { zen: 'Keep it logically awesome.' });
  let row = await rowFor(r.guid);
  check('ping → procesado y registrado', r.status === 201 && row.outcome === 'processed' && row.reason === 'ping' && row.github_app_row_id === appRow && row.organization_id === orgA);
  check('se guardan origen, user-agent y content-type', row.user_agent === 'GitHub-Hookshot/e2e' && row.content_type === 'application/json' && row.payload_bytes > 0 && row.duration_ms >= 0 && row.status_code === 201);

  r = await hook('push', push(sha('a'), 'refs/heads/feature/x'));
  row = await rowFor(r.guid);
  check('push a repo no sincronizado → registrado al vuelo y encolado', row.reason === 'repo_registered_queued' && row.repository === REPO.full_name && row.ref === 'refs/heads/feature/x' && row.commit_sha === sha('a') && !!row.review_run_id, JSON.stringify(row));

  r = await hook('push', push(sha('a'), 'refs/heads/feature/x'));
  check('mismo commit otra vez → ignorado: duplicado', (await rowFor(r.guid)).reason === 'duplicate');

  r = await hook('push', push(sha('b'), 'refs/heads/main'));
  row = await rowFor(r.guid);
  check('push a la rama principal → ignorado: rama omitida (con explicación)', row.outcome === 'ignored' && row.reason === 'ignored_branch' && /"main"/.test(row.detail));

  r = await hook('push', push(sha('c'), 'refs/tags/v1'));
  check('tag → ignorado: no es una rama', (await rowFor(r.guid)).reason === 'not_a_branch');
  r = await hook('push', push('0'.repeat(40), 'refs/heads/feature/x'));
  check('borrado de rama → ignorado', (await rowFor(r.guid)).reason === 'branch_deleted');

  r = await hook('push', { ...push(sha('d'), 'refs/heads/feature/y'), installation: undefined });
  check('push sin installation.id → ignorado con motivo', (await rowFor(r.guid)).reason === 'no_installation');

  r = await hook('pull_request', { action: 'closed', repository: REPO, pull_request: {} });
  row = await rowFor(r.guid);
  check('pull_request.closed → ignorado: acción sin análisis', row.reason === 'ignored_action' && row.action === 'closed');

  r = await hook('issues', {
    action: 'opened',
    repository: REPO,
    issue: { number: 7, title: 'Bug', body: 'x', state: 'open', user: { login: 'dev' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  });
  row = await rowFor(r.guid);
  check('issue → sincronizado y registrado', row.outcome === 'processed' && row.reason === 'issue_synced' && row.action === 'opened');
  check('el issue quedó espejado en la base', (await q(`SELECT 1 FROM issues WHERE github_issue_number = 7 AND organization_id = $1`, [orgA])).length === 1);

  r = await hook('star', { action: 'created' });
  check('evento que DevSentinel no usa → ignorado con motivo', (await rowFor(r.guid)).reason === 'ignored_event');

  r = await hook('push', push(sha('e'), 'refs/heads/feature/form'), { form: true });
  row = await rowFor(r.guid);
  check('webhook con content-type form-urlencoded también se procesa', r.status === 201 && row.reason === 'queued' && row.content_type === 'application/x-www-form-urlencoded', JSON.stringify(row));

  r = await hook('push', { ref: 'refs/heads/feature/boom', after: sha('f'), installation: { id: 1 } });
  row = await rowFor(r.guid);
  check('payload que revienta el handler → 500 y fila "error" con el mensaje', r.status === 500 && row.outcome === 'error' && row.reason === 'exception' && !!row.detail, JSON.stringify(row));

  // ===== rechazos =====
  r = await hook('push', push(sha('g'), 'refs/heads/feature/z'), { secret: 'otro-secret' });
  row = await rowFor(r.guid);
  check('firma inválida → 401, registrada con la App y la organización', r.status === 401 && row.reason === 'bad_signature' && row.outcome === 'rejected' && row.github_app_row_id === appRow && row.organization_id === orgA);
  check('de un rechazo NO se guarda nada del payload (no es de fiar)', row.repository === null && row.ref === null && row.commit_sha === null);

  const UNKNOWN = '999' + suffix.replace(/\D/g, '1');
  r = await hook('push', push(sha('h'), 'refs/heads/feature/z'), { appId: UNKNOWN });
  row = await rowFor(r.guid);
  check('App ID desconocido → 401, registrado con el App ID recibido y sin organización', r.status === 401 && row.reason === 'unknown_app' && row.github_app_id === UNKNOWN && row.organization_id === null && /Client ID/.test(row.detail));

  r = await hook('push', push(sha('i'), 'refs/heads/feature/z'), { appId: null });
  check('sin header de App ID → 401 registrado', (await rowFor(r.guid)).reason === 'missing_app_id');

  // ===== API del registro =====
  check('sin sesión → 401', (await api('/webhook-log', undefined)).status === 401);
  const userCookie = await cookieFor(userEmail, 'Passw0rd!log');
  check('un usuario que no es admin → 403', (await api('/webhook-log', userCookie)).status === 403 && (await api('/webhook-log/summary', userCookie)).status === 403);

  const adminCookie = await cookieFor(adminEmail, 'Passw0rd!log');
  const all = (await api('/webhook-log?limit=200', adminCookie)).json;
  check('el admin ve las entregas de su organización', all.items.some((d) => d.reason === 'repo_registered_queued') && all.items.some((d) => d.reason === 'bad_signature'));
  check('…y los rechazos sin organización (App ID desconocido)', all.items.some((d) => d.github_app_id === UNKNOWN));
  check('…pero nunca las de otra organización', !all.items.some((d) => d.github_app_row_id === appRowB));
  check('el nombre de la App viene en cada fila', all.items.find((d) => d.reason === 'ping').app_name === 'Secundaria');
  const queued = all.items.find((d) => d.reason === 'repo_registered_queued');
  check('el estado del análisis ligado viene en la fila', queued.review_status === 'running');

  const rejected = (await api('/webhook-log?outcome=rejected&limit=200', adminCookie)).json.items;
  check('filtro por resultado', rejected.length === 3 && rejected.every((d) => d.outcome === 'rejected'));
  const unknownOnly = (await api('/webhook-log?app=unknown&limit=200', adminCookie)).json.items;
  check('filtro "App no reconocida"', unknownOnly.length >= 2 && unknownOnly.every((d) => d.github_app_row_id === null));
  const byApp = (await api(`/webhook-log?app=${appRow}&limit=200`, adminCookie)).json.items;
  check('filtro por App', byApp.length > 0 && byApp.every((d) => d.github_app_row_id === appRow));
  const pushes = (await api(`/webhook-log?event=push&app=${appRow}&limit=200`, adminCookie)).json.items;
  check('filtro por evento', pushes.length > 0 && pushes.every((d) => d.event === 'push'));

  const page1 = (await api(`/webhook-log?app=${appRow}&limit=3`, adminCookie)).json;
  const page2 = (await api(`/webhook-log?app=${appRow}&limit=3&before=${encodeURIComponent(page1.items[2].received_at)}`, adminCookie)).json;
  check('paginación: hasMore y cursor `before` sin repetir filas', page1.items.length === 3 && page1.hasMore === true && page2.items.every((d) => !page1.items.some((p) => p.id === d.id)));

  const summary = (await api('/webhook-log/summary', adminCookie)).json;
  const card = summary.apps.find((a) => a.app_row_id === appRow);
  check('resumen por App: contadores de 24 h', card && card.processed_24h >= 4 && card.ignored_24h >= 5 && card.rejected_24h === 1 && card.error_24h === 1 && card.last_push_at && card.last_problem_at);
  check('resumen: la otra organización no aparece', !summary.apps.some((a) => a.app_row_id === appRowB));
  check('resumen: App ID desconocido listado con su motivo', summary.unknownApps.some((u) => u.github_app_id === UNKNOWN && u.reasons.includes('unknown_app')));

  const test = await api(`/github-apps/${appRow}/webhook-test`, adminCookie, 'POST');
  check('"Enviar prueba" con credenciales que GitHub no acepta → 502 con motivo (no un 500 genérico)', test.status === 502 && /GitHub/.test(test.json.message ?? ''), JSON.stringify(test));

  // Las entregas rechazadas sin App ID ni organización (header faltante) solo se reconocen por su user-agent.
  await q(`DELETE FROM webhook_deliveries WHERE user_agent = 'GitHub-Hookshot/e2e' OR organization_id = ANY($1)`, [[orgA, orgB]]);
  await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@log.test`]);
  await q('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
  await owner.end();
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
