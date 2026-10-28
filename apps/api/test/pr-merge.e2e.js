/* Pruebas del flujo "crear PR y mergear en el momento": creación desde un push, el PR asociado en la lista de pushes,
 * la validación previa al merge (con espera mientras GitHub calcula si es mergeable) y el merge, contra un GitHub
 * simulado (GITHUB_API_URL=http://api:4010 en el contenedor de la API).
 *
 * Uso (desde la raíz del repo, con postgres y api levantados):
 *   docker compose exec -T api node - < apps/api/test/pr-merge.e2e.js
 *
 * Crea organizaciones de prueba y las borra al terminar. */
const crypto = require('crypto');
const http = require('http');
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
const randomIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
const call = async (path, cookie, { method = 'GET', body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: cookie ?? '', 'x-forwarded-for': randomIp(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};
async function cookieFor(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}

// ---------------------------------------------------------------- GitHub simulado
const gh = {
  prs: new Map(), // número -> { title, head, base }
  nextNumber: 101,
  states: [], // cola de mergeable_state; el último se repite
  draft: false,
  prState: 'open',
  mergeStatus: 200, // respuesta del PUT merge
  statusGets: 0,
  merges: [],
  created: [],
  checks: [{ name: 'ci / test', status: 'completed', conclusion: 'success' }],
};
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const body = raw ? JSON.parse(raw) : {};
    let m;
    if (/\/access_tokens$/.test(url.pathname)) return send(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'all' });
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls$/))) {
      const head = (url.searchParams.get('head') ?? '').split(':')[1];
      const found = [...gh.prs.entries()].filter(([, pr]) => pr.head === head);
      return send(200, found.map(([number]) => ({ number })));
    }
    if (req.method === 'POST' && /\/pulls$/.test(url.pathname)) {
      const number = gh.nextNumber++;
      gh.prs.set(number, { title: body.title, head: body.head, base: body.base });
      gh.created.push(number);
      return send(201, { number, html_url: `https://github.com/x/y/pull/${number}`, user: { login: 'devsentinel[bot]' } });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/\/pulls\/(\d+)$/))) {
      gh.statusGets++;
      const state = gh.states.length > 1 ? gh.states.shift() : (gh.states[0] ?? 'clean');
      return send(200, { number: Number(m[1]), state: gh.prState, draft: gh.draft, mergeable: state === 'clean' ? true : null, mergeable_state: state, head: { sha: 'f'.repeat(40) } });
    }
    if (req.method === 'GET' && /\/check-runs$/.test(url.pathname)) return send(200, { total_count: gh.checks.length, check_runs: gh.checks });
    if (req.method === 'PUT' && (m = url.pathname.match(/\/pulls\/(\d+)\/merge$/))) {
      gh.merges.push(Number(m[1]));
      if (gh.mergeStatus !== 200) return send(gh.mergeStatus, { message: 'Pull Request is not mergeable' });
      return send(200, { merged: true, sha: 'a'.repeat(40), message: 'Pull Request successfully merged' });
    }
    send(404, { message: `mock: ruta no simulada ${req.method} ${url.pathname}` });
  });
});

(async () => {
  await new Promise((r) => server.listen(4010, '0.0.0.0', r));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const hash = await bcrypt.hash('Passw0rd!prm', 10);
  const mkOrg = async (label) => (await q(`INSERT INTO organizations(name, slug) VALUES ($1, $2) RETURNING id`, [label, `${label.toLowerCase()}-${suffix}`]))[0].id;
  const orgA = await mkOrg('PrmA');
  const orgB = await mkOrg('PrmB');
  const mkUser = async (label, org, role) => {
    const email = `${label}-${suffix}@prm.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return email;
  };
  const adminEmail = await mkUser('admin', orgA, 'admin');
  const userEmail = await mkUser('user', orgA, 'user');
  const adminB = await mkUser('adminb', orgB, 'admin');
  const mkRepo = async (org, name) => {
    const app = (await q(
      `INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
       VALUES ($1, 'App', $2, 'a', 'c', $3, $4, $5) RETURNING id`,
      [org, String(600000 + crypto.randomInt(1, 99999)), encrypt('x'), encrypt(privateKey), encrypt('w')],
    ))[0].id;
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login, github_app_id) VALUES ($1, $2, 'acme', $3) RETURNING id`, [org, 950000 + crypto.randomInt(1, 99999), app]))[0].id;
    return (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, $4) RETURNING id`, [org, inst, 995000 + crypto.randomInt(1, 99999), name]))[0].id;
  };
  const repo = await mkRepo(orgA, `acme-${suffix}/demo`);
  const repoB = await mkRepo(orgB, `other-${suffix}/demo`);
  const mkRun = async (org, repoId, branch, status, gate) =>
    (await q(
      `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, quality_score, risk_level, gate_decision, summary)
       VALUES ($1, $2, $3, 'push', $4, $5, 88, 'low', $6, 'Resumen del análisis') RETURNING id`,
      [org, repoId, crypto.randomBytes(20).toString('hex'), status, branch, gate],
    ))[0].id;
  const okRun = await mkRun(orgA, repo, 'staging', 'completed', 'apto');
  const badRun = await mkRun(orgA, repo, 'feature/malo', 'completed', 'no_apto');
  const runningRun = await mkRun(orgA, repo, 'feature/en-curso', 'running', null);
  const runB = await mkRun(orgB, repoB, 'staging', 'completed', 'apto');
  await q(`INSERT INTO quality_gate_configs(organization_id, repository_id, promotion_source_branch, promotion_target_branch) VALUES ($1, $2, 'staging', 'main')`, [orgA, repo]);

  try {
    const admin = await cookieFor(adminEmail, 'Passw0rd!prm');
    const user = await cookieFor(userEmail, 'Passw0rd!prm');
    const adminOther = await cookieFor(adminB, 'Passw0rd!prm');
    check('login de prueba', !!admin && !!user && !!adminOther);

    const pushOf = async (runId) => (await call(`/dashboard/repositories/${repo}/pushes?page=1&pageSize=50`, admin)).json.items.find((p) => p.id === runId);
    let p = await pushOf(okRun);
    check('antes de crear el PR, el push no tiene PR asociado', p.pull_request_id === null && p.pr_number === null && p.pr_url === null, JSON.stringify(p));

    // ------------------------------------------------------------ creación
    check('crear PR: un usuario no admin → 403', (await call('/pull-requests/from-push', user, { method: 'POST', body: { repositoryId: repo, reviewRunId: okRun } })).status === 403);
    check('crear PR de un análisis que no terminó → 400', (await call('/pull-requests/from-push', admin, { method: 'POST', body: { repositoryId: repo, reviewRunId: runningRun } })).status === 400);
    let r = await call('/pull-requests/from-push', admin, { method: 'POST', body: { repositoryId: repo, reviewRunId: okRun } });
    const pr1 = r.json;
    check('crear PR desde un push → 201 con el PR y su número', r.status === 201 && pr1.github_pr_number === 101 && pr1.status === 'open' && pr1.source_review_run_id === okRun, r.text);
    check('GitHub recibió el PR de staging hacia main', gh.prs.get(101)?.head === 'staging' && gh.prs.get(101)?.base === 'main');
    p = await pushOf(okRun);
    check('la lista de pushes ahora muestra el PR (número, estado y enlace)', p.pull_request_id === pr1.id && p.pr_number === 101 && p.pr_status === 'open' && p.pr_url === `https://github.com/acme-${suffix}/demo/pull/101`, JSON.stringify(p));
    r = await call('/pull-requests/from-push', admin, { method: 'POST', body: { repositoryId: repo, reviewRunId: okRun } });
    check('crear de nuevo reutiliza el PR (no duplica en GitHub ni en la base)', r.json.id === pr1.id && gh.created.length === 1 && (await q('SELECT count(*)::int AS n FROM pull_requests WHERE repository_id = $1', [repo]))[0].n === 1);

    // ------------------------------------------------------------ validación
    const validate = (id = pr1.id, cookie = admin) => call(`/pull-requests/${id}/validate-merge`, cookie, { method: 'POST' });
    check('validar: un usuario no admin → 403', (await validate(pr1.id, user)).status === 403);

    gh.states = ['clean'];
    r = await validate();
    check('validar con todo en regla → puede mergear, con el resumen para la ventana', r.status === 201 && r.json.canMerge === true && r.json.pending === false && r.json.reasons.length === 0, r.text);
    const s = r.json.summary;
    check('el resumen trae PR, ramas, veredicto, score, riesgo y checks', s.number === 101 && s.head === 'staging' && s.base === 'main' && s.verdict === 'apto' && s.score === 88 && s.risk === 'low' && s.checks[0].name === 'ci / test' && s.url.endsWith('/pull/101'), JSON.stringify(s));

    gh.states = ['unknown', 'unknown', 'clean']; gh.statusGets = 0;
    const t0 = Date.now();
    r = await validate();
    check('recién creado: espera a que GitHub calcule si es mergeable (unknown → unknown → clean)', r.json.canMerge === true && r.json.pending === false && gh.statusGets === 3 && Date.now() - t0 >= 2800, `${gh.statusGets} consultas, ${Date.now() - t0} ms`);

    gh.states = ['unknown']; gh.statusGets = 0;
    r = await validate();
    check('si GitHub no termina de calcular → pending, no mergeable, con mensaje claro y sin colgarse', r.json.canMerge === false && r.json.pending === true && /todavía está calculando/.test(r.json.reasons.join()) && gh.statusGets === 7, `${gh.statusGets} consultas: ${r.text}`);

    for (const [state, re] of [['dirty', /conflictos/], ['behind', /desactualizada/], ['blocked', /bloqueado por revisiones/], ['unstable', /checks no obligatorios/]]) {
      gh.states = [state];
      r = await validate();
      check(`validar con estado "${state}" → no mergeable (${re.source})`, r.json.canMerge === false && re.test(r.json.reasons.join()) && r.json.pending === false, r.text);
    }
    gh.states = ['clean']; gh.draft = true;
    check('PR en borrador → no mergeable', (await validate()).json.reasons.some((x) => /borrador/.test(x)));
    gh.draft = false; gh.prState = 'closed';
    check('PR cerrado en GitHub → no mergeable', (await validate()).json.reasons.some((x) => /no está abierto/.test(x)));
    gh.prState = 'open';
    gh.checks = [{ name: 'ci / test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }];
    r = await validate();
    check('los checks (fallido y en curso) llegan en el resumen', r.json.summary.checks.length === 2 && r.json.summary.checks[0].conclusion === 'failure' && r.json.summary.checks[1].status === 'in_progress');
    gh.checks = [{ name: 'ci / test', status: 'completed', conclusion: 'success' }];

    // ------------------------------------------------------------ análisis NO APTO / sin terminar
    const badPrRow = (await q(
      `INSERT INTO pull_requests(organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, source_review_run_id, created_by)
       VALUES ($1, $2, 555, 'PR con análisis malo', 'feature/malo', 'main', 'dev', 'open', $3, 'devsentinel') RETURNING id`,
      [orgA, repo, badRun],
    ))[0].id;
    gh.states = ['clean'];
    r = await validate(badPrRow);
    check('el análisis NO APTO impide mergear y se ve en el resumen', r.json.canMerge === false && r.json.reasons.some((x) => /NO APTO/.test(x)) && r.json.summary.verdict === 'no_apto', r.text);
    const orphan = (await q(
      `INSERT INTO pull_requests(organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, created_by)
       VALUES ($1, $2, 556, 'PR sin análisis', 'feature/x', 'main', 'dev', 'open', 'github') RETURNING id`,
      [orgA, repo],
    ))[0].id;
    check('un PR sin análisis de DevSentinel no se puede mergear', (await validate(orphan)).json.reasons.some((x) => /no hay un análisis/.test(x)));

    // ------------------------------------------------------------ merge
    gh.states = ['dirty'];
    r = await call(`/pull-requests/${pr1.id}/merge`, admin, { method: 'POST' });
    check('mergear con conflictos → 400 con los motivos y GitHub NO recibe el merge', r.status === 400 && /conflictos/.test(r.text) && gh.merges.length === 0, r.text);
    check('mergear: un usuario no admin → 403', (await call(`/pull-requests/${pr1.id}/merge`, user, { method: 'POST' })).status === 403);
    check('mergear un PR de otra organización → 404 (RLS)', (await call(`/pull-requests/${pr1.id}/validate-merge`, adminOther, { method: 'POST' })).status === 404);

    gh.states = ['clean']; gh.mergeStatus = 405;
    r = await call(`/pull-requests/${pr1.id}/merge`, admin, { method: 'POST' });
    check('si GitHub rechaza el merge (405) → 400 explicado y el PR sigue abierto', r.status === 400 && /GitHub rechazó el merge/.test(r.text) && (await q('SELECT status FROM pull_requests WHERE id = $1', [pr1.id]))[0].status === 'open', r.text);
    gh.mergeStatus = 200;
    r = await call(`/pull-requests/${pr1.id}/merge`, admin, { method: 'POST' });
    check('mergear con todo en regla → merged', r.status === 201 && r.json.merged === true && gh.merges.at(-1) === 101, r.text);
    const row = (await q('SELECT status, merged_at FROM pull_requests WHERE id = $1', [pr1.id]))[0];
    check('el PR queda "merged" con fecha', row.status === 'merged' && !!row.merged_at);
    p = await pushOf(okRun);
    check('la lista de pushes lo muestra como mergeado', p.pr_status === 'merged');
    r = await validate();
    check('un PR ya mergeado no se puede volver a mergear', r.json.canMerge === false && r.json.reasons.some((x) => /ya está merged/.test(x)), r.text);
    check('otra organización no ve los pushes ni PRs de la primera', (await call(`/dashboard/repositories/${repo}/pushes`, adminOther)).json.items?.length === 0 || (await call(`/dashboard/repositories/${repo}/pushes`, adminOther)).status >= 400);
    void runB;
  } finally {
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@prm.test`]);
    await q('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    await owner.end();
    server.close();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
