/* Pruebas de punta a punta del indicador "apto para recibir pushes" (/repository-readiness) y de
 * "Generar contexto" (/dashboard/repositories/:id/project-profile/generate + worker), contra una
 * API y un worker en marcha.
 *
 * El script levanta DENTRO del contenedor de la API un GitHub y un proveedor de LLM simulados
 * (puerto 4010); api y worker deben apuntar a él, así que hay que arrancarlos con:
 *   GITHUB_API_URL=http://api:4010   PUBLIC_WEB_ORIGIN=http://localhost   CONFIG_ENCRYPTION_KEY=<clave>
 * (ejemplo: un docker-compose.override con esas variables en `api` y `worker`).
 *
 * Uso (desde la raíz del repo, con postgres, redis, api y worker levantados):
 *   docker compose exec -T api node - < apps/api/test/readiness-context.e2e.js
 *
 * Crea organizaciones/Apps/repos de prueba y los borra al terminar; restaura la configuración
 * de los agentes de IA (llm_providers) que hubiera. */
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { encrypt } = require('@devsentinel/settings');

const BASE = 'http://localhost:3000/api';
const MOCK_PORT = 4010;
const ORIGIN = (process.env.PUBLIC_WEB_ORIGIN || '').replace(/\/+$/, '');
const EXPECTED_HOOK = `${ORIGIN}/api/webhooks/github`;
const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
const q = async (sql, params) => (await owner.query(sql, params)).rows;

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = crypto.randomBytes(3).toString('hex');
const randomIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
const num = () => 500000 + crypto.randomInt(1, 400000);

// ---------------------------------------------------------------- GitHub + LLM simulados
const FULL_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'check_suite'];
const FULL_PERMS = { contents: 'read', metadata: 'read', pull_requests: 'write', issues: 'write', checks: 'write' };
const mock = {
  apps: {}, // appId -> { events, permissions, hookUrl }
  installations: {}, // installationId -> { events, permissions, type, login, suspended_at, repos: [{id, full_name}] }
  contents: {}, // "owner/repo:path" -> array (dir) | string (file)
  llm: { delayMs: 0, profile: {}, lastBody: '' },
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const jwtIssuer = (req) => {
  const token = (req.headers.authorization || '').replace(/^(Bearer|token)\s+/i, '');
  try {
    return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).iss);
  } catch {
    return null;
  }
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const p = decodeURIComponent(url.pathname);
    let m;
    if (p === '/v1/chat/completions') {
      mock.llm.lastBody = body;
      if (mock.llm.delayMs) await sleep(mock.llm.delayMs);
      return json(res, 200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(mock.llm.profile) } }] });
    }
    if (p === '/app') {
      const app = mock.apps[jwtIssuer(req)];
      return app ? json(res, 200, { id: Number(jwtIssuer(req)), slug: 'app', events: app.events, permissions: app.permissions }) : json(res, 404, { message: 'Not Found' });
    }
    if (p === '/app/hook/config') {
      const app = mock.apps[jwtIssuer(req)];
      return app ? json(res, 200, { url: app.hookUrl, content_type: 'json' }) : json(res, 404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      return json(res, 201, { token: `ghs_${m[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'all' });
    }
    if ((m = p.match(/^\/app\/installations\/(\d+)$/))) {
      const inst = mock.installations[m[1]];
      if (!inst || !mock.apps[jwtIssuer(req)]) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, {
        id: Number(m[1]),
        account: { login: inst.login, type: inst.type },
        repository_selection: 'selected',
        events: inst.events,
        permissions: inst.permissions,
        suspended_at: inst.suspended_at || null,
      });
    }
    if (p === '/installation/repositories') {
      const inst = mock.installations[(req.headers.authorization || '').replace(/^\S+\s+ghs_/, '')];
      if (!inst) return json(res, 401, { message: 'Bad credentials' });
      return json(res, 200, { total_count: inst.repos.length, repositories: inst.repos.map((r) => ({ id: r.id, full_name: r.full_name, default_branch: 'main' })) });
    }
    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/))) {
      const entry = mock.contents[`${m[1]}/${m[2]}:${m[3].replace(/\/$/, '')}`];
      if (entry === undefined) return json(res, 404, { message: 'Not Found' });
      if (Array.isArray(entry)) return json(res, 200, entry.map((e) => ({ type: e.type, name: e.name, path: m[3] ? `${m[3]}/${e.name}` : e.name })));
      const name = m[3].split('/').pop();
      return json(res, 200, { type: 'file', name, path: m[3], encoding: 'base64', content: Buffer.from(entry).toString('base64') });
    }
    json(res, 404, { message: `mock: ruta no simulada ${req.method} ${p}` });
  });
});

// ---------------------------------------------------------------- helpers de API
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
async function waitRun(cookie, repoId, runId, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`/dashboard/repositories/${repoId}/project-profile/generation`, cookie);
    if (r.json && r.json.id === runId && (r.json.status === 'done' || r.json.status === 'failed')) return r.json;
    await sleep(700);
  }
  return null;
}

(async () => {
  if (!ORIGIN) {
    console.error('Falta PUBLIC_WEB_ORIGIN en el contenedor de la API (ver el encabezado del script).');
    process.exit(2);
  }
  await new Promise((resolve) => server.listen(MOCK_PORT, '0.0.0.0', resolve));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

  const hashPw = await bcrypt.hash('Passw0rd!rdy', 10);
  const orgA = (await q(`INSERT INTO organizations(name, slug) VALUES ('Rdy A', $1) RETURNING id`, [`rdy-a-${suffix}`]))[0].id;
  const orgB = (await q(`INSERT INTO organizations(name, slug) VALUES ('Rdy B', $1) RETURNING id`, [`rdy-b-${suffix}`]))[0].id;
  const mkUser = async (label, org, role) => {
    const email = `${label}-${suffix}@rdy.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hashPw]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return email;
  };
  const adminEmail = await mkUser('admin', orgA, 'admin');
  const userEmail = await mkUser('user', orgA, 'user');

  const mkApp = async (org, appId, name) =>
    (await q(
      `INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
       VALUES ($1, $2, $3, $4, 'cid', $5, $6, $7) RETURNING id`,
      [org, name, appId, `slug-${appId}`, encrypt('x'), encrypt(privateKey), encrypt('whsec')],
    ))[0].id;
  const mkInst = async (org, instId, appRow, login) =>
    (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login, github_app_id) VALUES ($1, $2, $3, $4) RETURNING id`, [org, instId, login, appRow]))[0].id;
  const mkRepo = async (org, instRow, name) => {
    const id = num();
    const row = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name, default_branch, webhook_status) VALUES ($1, $2, $3, $4, 'main', 'active') RETURNING id`, [org, instRow, id, name]))[0];
    return { id: row.id, ghId: id, name };
  };

  const idA = String(num()), idB = String(num()), idC = String(num()), idD = String(num());
  const instA = num(), instB = num(), instC = num(), instD = num(), instE = num();
  const appA = await mkApp(orgA, idA, 'Principal');
  const appB = await mkApp(orgA, idB, 'Secundaria');
  const appC = await mkApp(orgA, idC, 'Pendiente');
  const appD = await mkApp(orgA, idD, 'Credenciales malas'); // el simulador no la conoce → 404
  const rowA = await mkInst(orgA, instA, appA, `acme-${suffix}`);
  const rowB = await mkInst(orgA, instB, appB, `acme-${suffix}`);
  const rowC = await mkInst(orgA, instC, appC, `corp-${suffix}`);
  const rowD = await mkInst(orgA, instD, appD, `acme-${suffix}`);
  const rowE = await mkInst(orgA, instE, null, `acme-${suffix}`); // instalación sin App asociada

  const A1 = await mkRepo(orgA, rowA, `acme-${suffix}/healthy`);
  const A2 = await mkRepo(orgA, rowA, `acme-${suffix}/removed`);
  const A3 = await mkRepo(orgA, rowA, `acme-${suffix}/fresh`);
  const B1 = await mkRepo(orgA, rowB, `acme-${suffix}/secondary`);
  const C1 = await mkRepo(orgA, rowC, `corp-${suffix}/pending`);
  const D1 = await mkRepo(orgA, rowD, `acme-${suffix}/badcreds`);
  const E1 = await mkRepo(orgA, rowE, `acme-${suffix}/noapp`);
  const rowOther = await mkInst(orgB, num(), await mkApp(orgB, String(num()), 'Otra org'), 'other');
  const OTHER = await mkRepo(orgB, rowOther, `other-${suffix}/repo`);

  mock.apps[idA] = { events: FULL_EVENTS, permissions: FULL_PERMS, hookUrl: EXPECTED_HOOK };
  mock.installations[instA] = { events: FULL_EVENTS, permissions: FULL_PERMS, type: 'User', login: `acme-${suffix}`, repos: [{ id: A1.ghId, full_name: A1.name }, { id: A3.ghId, full_name: A3.name }] };
  // La secundaria: sin push suscrito, sin Contents y con la URL del webhook mal puesta
  mock.apps[idB] = { events: ['check_suite', 'pull_request'], permissions: { metadata: 'read', checks: 'write', pull_requests: 'write' }, hookUrl: 'https://otro-dominio.example/api/webhooks/github' };
  mock.installations[instB] = { events: ['check_suite', 'pull_request'], permissions: { metadata: 'read', checks: 'write', pull_requests: 'write' }, type: 'User', login: `acme-${suffix}`, repos: [{ id: B1.ghId, full_name: B1.name }] };
  // La pendiente: la App YA declara todo, pero la cuenta (organización) no aceptó los permisos nuevos
  mock.apps[idC] = { events: FULL_EVENTS, permissions: FULL_PERMS, hookUrl: EXPECTED_HOOK };
  mock.installations[instC] = { events: ['check_suite'], permissions: { metadata: 'read' }, type: 'Organization', login: `corp-${suffix}`, repos: [{ id: C1.ghId, full_name: C1.name }] };

  // A1 lista del todo: perfil + un push recibido. A3 sin perfil ni pushes. B1 recibió check_suite pero nunca push.
  await q(`INSERT INTO project_profiles(organization_id, repository_id, language) VALUES ($1, $2, 'typescript')`, [orgA, A1.id]);
  await q(`INSERT INTO webhook_deliveries(event, organization_id, github_app_row_id, github_app_id, outcome, reason, repository, status_code, user_agent)
           VALUES ('push', $1, $2, $3, 'processed', 'queued', $4, 201, 'GitHub-Hookshot/rdy')`, [orgA, appA, idA, A1.name]);
  for (let i = 0; i < 2; i++) {
    await q(`INSERT INTO webhook_deliveries(event, organization_id, github_app_row_id, github_app_id, outcome, reason, status_code, user_agent)
             VALUES ('check_suite', $1, $2, $3, 'ignored', 'ignored_event', 201, 'GitHub-Hookshot/rdy')`, [orgA, appB, idB]);
  }

  const admin = await cookieFor(adminEmail, 'Passw0rd!rdy');
  const user = await cookieFor(userEmail, 'Passw0rd!rdy');
  const originalProviders = await q('SELECT * FROM llm_providers');

  try {
    // ================================================================== INDICADOR DE APTITUD
    check('login de prueba', !!admin && !!user);
    check('sin sesión → 401', (await api('/repository-readiness')).status === 401);
    check('usuario no admin → 403', (await api('/repository-readiness', user)).status === 403);

    const all = await api('/repository-readiness', admin);
    check('admin recibe la lista', all.status === 200 && Array.isArray(all.json), JSON.stringify(all.json).slice(0, 200));
    const by = Object.fromEntries((all.json || []).map((r) => [r.repositoryId, r]));
    const item = (r, key) => r.items.find((i) => i.key === key);
    check('solo repos de la propia organización', !by[OTHER.id] && Object.keys(by).length === 7);

    const a1 = by[A1.id];
    check('A1 (todo en regla, perfil y push recibido) → apto', a1.status === 'ready' && a1.summary === 'Listo para recibir pushes', `${a1.status} ${a1.summary}`);
    check('A1: política de ramas informa que se omite main', /main/.test(item(a1, 'branch_policy').title));
    check('A1: muestra el último push recibido', item(a1, 'push_seen').ok && /queued/.test(item(a1, 'push_seen').message));

    const a2 = by[A2.id];
    check('A2 (ya no está en la instalación) → bloqueado: repo fuera de la instalación', a2.status === 'blocked' && a2.summary === 'Repo fuera de la instalación', `${a2.status} ${a2.summary}`);

    const a3 = by[A3.id];
    check('A3 (sin push ni contexto) → apto con recomendaciones', a3.status === 'attention' && a3.summary === 'Aún no llega ningún push', `${a3.status} ${a3.summary}`);
    check('A3: recomienda generar contexto con enlace a la pestaña', !item(a3, 'project_context').ok && item(a3, 'project_context').link.href === `/repositories/${A3.id}/project-profile`);

    const b1 = by[B1.id];
    check('B1 (la secundaria) → bloqueado', b1.status === 'blocked', `${b1.status} ${b1.summary}`);
    check('B1: detecta que push NO está suscrito', !item(b1, 'events').ok && /push/.test(item(b1, 'events').title), item(b1, 'events').title);
    check('B1: detecta la URL del webhook equivocada', !item(b1, 'webhook_url').ok && /otro-dominio/.test(item(b1, 'webhook_url').message));
    check('B1: detecta que la App no pide Contents', !item(b1, 'installation_permissions').ok && /Contents/.test(item(b1, 'installation_permissions').message) && /no los tiene configurados/.test(item(b1, 'installation_permissions').message));
    check('B1: explica que llegan check_suite pero ningún push', /check_suite ×2/.test(item(b1, 'push_seen').message) && /ningún push/.test(item(b1, 'push_seen').message), item(b1, 'push_seen').message);

    const c1 = by[C1.id];
    check('C1 (permisos sin aceptar) → bloqueado: eventos pendientes de aceptar', c1.status === 'blocked' && item(c1, 'events').title === 'Eventos pendientes de aceptar', item(c1, 'events').title);
    check('C1: permisos pendientes de aceptar, con enlace a la instalación de la organización',
      item(c1, 'installation_permissions').title === 'Permisos pendientes de aceptar' &&
        item(c1, 'installation_permissions').link.href === `https://github.com/organizations/corp-${suffix}/settings/installations/${instC}`,
      JSON.stringify(item(c1, 'installation_permissions')));
    check('C1: el mensaje dice que la App ya los declara y la cuenta no los aceptó', /ya los declara/.test(item(c1, 'installation_permissions').message));

    const d1 = by[D1.id];
    check('D1 (credenciales rechazadas por GitHub) → bloqueado, no "desconocido"', d1.status === 'blocked' && d1.summary === 'Credenciales de la App rechazadas', `${d1.status} ${d1.summary}`);
    check('E1 (instalación sin App) → bloqueado: sin GitHub App asociada', by[E1.id].status === 'blocked' && by[E1.id].summary === 'Sin GitHub App asociada');

    const one = await api(`/repository-readiness?repositoryId=${B1.id}`, admin);
    check('con repositoryId devuelve solo ese repo', one.status === 200 && one.json.length === 1 && one.json[0].repositoryId === B1.id);
    check('repositoryId de otra organización → lista vacía (RLS)', (await api(`/repository-readiness?repositoryId=${OTHER.id}`, admin)).json.length === 0);

    // La instalación C acepta los permisos: el caché de 60 s evita reconsultar, "Reverificar" lo salta
    mock.installations[instC] = { ...mock.installations[instC], events: FULL_EVENTS, permissions: FULL_PERMS };
    check('dentro del caché sigue igual (no gasta rate limit)', (await api(`/repository-readiness?repositoryId=${C1.id}`, admin)).json[0].status === 'blocked');
    const fresh = await api(`/repository-readiness?repositoryId=${C1.id}&refresh=1`, admin);
    check('refresh=1 reconsulta GitHub y el repo pasa a apto con recomendaciones', fresh.json[0].status === 'attention', `${fresh.json[0].status} ${fresh.json[0].summary}`);

    // ================================================================== GENERAR CONTEXTO
    mock.llm.profile = {
      language: 'TypeScript', framework: 'NestJS', framework_version: 'NestJS 10', runtime: 'Node 22', database: 'PostgreSQL',
      architecture_style: 'Monolito modular', testing_strategy: 'Jest', notes: 'API de demostración',
      mandatory_rules: [], security_rules: [], conventions: ['Usar DTOs'], migrations_policy: null, compatibility_notes: null,
    };
    for (const repo of [A3, A1]) {
      mock.contents[`${repo.name}:`] = [{ type: 'file', name: 'README.md' }, { type: 'file', name: 'package.json' }, { type: 'dir', name: 'src' }, { type: 'file', name: 'logo.png' }];
      mock.contents[`${repo.name}:README.md`] = '# Demo API\n\nAPI de pruebas para DevSentinel.';
      mock.contents[`${repo.name}:package.json`] = '{"dependencies":{"@nestjs/core":"^10.0.0"}}';
      mock.contents[`${repo.name}:src`] = [{ type: 'file', name: 'main.ts' }, { type: 'dir', name: 'modules' }];
    }
    // El agente de IA de la prueba es el simulado (se restauran los reales al terminar)
    await q('DELETE FROM llm_providers');
    await q(
      `INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position) VALUES ('Simulado', 'custom', $1, 'mock-model', $2, 1)`,
      [`http://api:${MOCK_PORT}/v1`, encrypt('k')],
    );
    const profileOf = async (repo) => (await q('SELECT * FROM project_profiles WHERE repository_id = $1', [repo.id]))[0];

    check('generar: sin sesión → 401', (await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, '', { method: 'POST', body: {} })).status === 401);
    check('generar: usuario no admin → 403', (await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, user, { method: 'POST', body: {} })).status === 403);
    check('generar: repo de otra organización → 404', (await api(`/dashboard/repositories/${OTHER.id}/project-profile/generate`, admin, { method: 'POST', body: {} })).status === 404);
    check('generation: aún sin corridas → null', (await api(`/dashboard/repositories/${A3.id}/project-profile/generation`, admin)).json === null);

    // 1) repo sin perfil: se crea como borrador generado
    mock.llm.delayMs = 1500;
    const start = await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, admin, { method: 'POST', body: {} });
    check('generar: encola una corrida', start.status === 201 && start.json.status === 'queued' && start.json.mode === 'fill', JSON.stringify(start));
    const second = await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, admin, { method: 'POST', body: {} });
    check('segundo clic mientras corre → devuelve la misma corrida (no apila otra)', second.json.id === start.json.id);
    const done1 = await waitRun(admin, A3.id, start.json.id);
    check('la corrida termina "done"', done1?.status === 'done', JSON.stringify(done1));
    const p1 = await profileOf(A3);
    check('perfil creado con lo que dijo el LLM', p1?.language === 'TypeScript' && p1.framework === 'NestJS' && p1.database === 'PostgreSQL' && p1.conventions.includes('Usar DTOs'), JSON.stringify(p1));
    check('queda marcado como generado, con sus fuentes (README + package.json, sin la estructura)', JSON.stringify(p1.auto_generated_from) === JSON.stringify(['README.md', 'package.json']), JSON.stringify(p1.auto_generated_from));
    check('la corrida informa fuentes y campos aplicados', done1.sources.includes('README.md') && done1.applied_fields.includes('language') && done1.applied_fields.includes('framework'));
    check('al LLM le llegó el README, el manifiesto y la estructura', /Demo API/.test(mock.llm.lastBody) && /@nestjs\/core/.test(mock.llm.lastBody) && /estructura de carpetas/.test(mock.llm.lastBody) && /main\.ts/.test(mock.llm.lastBody));
    mock.llm.delayMs = 0;

    // 2) perfil curado por una persona: solo se completan los vacíos
    await q(`UPDATE project_profiles SET language = 'PHP', framework = NULL, conventions = '{}', auto_generated_from = NULL WHERE repository_id = $1`, [A3.id]);
    const fill = await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, admin, { method: 'POST', body: {} });
    const done2 = await waitRun(admin, A3.id, fill.json.id);
    const p2 = await profileOf(A3);
    check('perfil curado: conserva lo escrito a mano (language=PHP)', done2?.status === 'done' && p2.language === 'PHP', JSON.stringify(p2));
    check('perfil curado: completa los campos vacíos (framework, convenciones)', p2.framework === 'NestJS' && p2.conventions.includes('Usar DTOs'));
    check('perfil curado: sigue siendo "de una persona" (sin marca de generado)', p2.auto_generated_from === null);
    check('perfil curado: informa solo lo que completó', done2.applied_fields.includes('framework') && !done2.applied_fields.includes('language'), JSON.stringify(done2.applied_fields));

    // 3) reemplazar todo, a pedido
    const rep = await api(`/dashboard/repositories/${A3.id}/project-profile/generate`, admin, { method: 'POST', body: { replace: true } });
    const done3 = await waitRun(admin, A3.id, rep.json.id);
    const p3 = await profileOf(A3);
    check('replace: pisa lo escrito a mano y queda como borrador generado', done3?.mode === 'replace' && p3.language === 'TypeScript' && Array.isArray(p3.auto_generated_from), JSON.stringify(p3));

    // 4) repo sin nada que leer
    // (el simulador no tiene contenidos para A2: GitHub responde 404 al listar la raíz)
    const empty = await api(`/dashboard/repositories/${A2.id}/project-profile/generate`, admin, { method: 'POST', body: {} });
    const done4 = await waitRun(admin, A2.id, empty.json.id);
    check('repo sin README/manifiestos → falla con un mensaje claro', done4?.status === 'failed' && /no hay de dónde sacar contexto/.test(done4.error_message), JSON.stringify(done4));
    check('el fallo no deja un perfil vacío', !(await profileOf(A2)));

    // 5) LLM sin configurar
    await q('UPDATE llm_providers SET enabled = false');
    const nollm = await api(`/dashboard/repositories/${A1.id}/project-profile/generate`, admin, { method: 'POST', body: {} });
    const done5 = await waitRun(admin, A1.id, nollm.json.id);
    check('LLM sin configurar → falla indicando dónde configurarlo', done5?.status === 'failed' && /ningún agente de IA activo/.test(done5.error_message), JSON.stringify(done5));

    // 6) el indicador se entera de que ya hay contexto
    await q('UPDATE llm_providers SET enabled = true');
    const readiness3 = await api(`/repository-readiness?repositoryId=${A3.id}&refresh=1`, admin);
    check('tras generar contexto el repo ya no recomienda generarlo', item(readiness3.json[0], 'project_context').ok && /IA/.test(item(readiness3.json[0], 'project_context').message), item(readiness3.json[0], 'project_context').message);
    const last = await api(`/dashboard/repositories/${A3.id}/project-profile/generation`, admin);
    check('generation devuelve la última corrida', last.json.id === rep.json.id && last.json.status === 'done');
  } finally {
    await q('DELETE FROM llm_providers');
    for (const p of originalProviders) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at],
      );
    }
    await q(`DELETE FROM webhook_deliveries WHERE user_agent = 'GitHub-Hookshot/rdy' OR organization_id = ANY($1)`, [[orgA, orgB]]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@rdy.test`]);
    await q('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    server.close();
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
