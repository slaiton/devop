/* Pruebas de las preguntas de la IA al desarrollador, del lado de la API:
 *   - POST /dashboard/findings/:id/clarifications (responder) y POST .../clarification-decision (decisión de un admin),
 *   - lo que devuelven GET /dashboard/review-runs/:id y la lista de pushes (conversación y contador de preguntas),
 *   - la respuesta que llega por un comentario de GitHub (webhook issue_comment): en el issue de seguimiento y en la
 *     conversación del PR; ignora bots, es idempotente y solo toca hallazgos pendientes.
 * Los trabajos de re-evaluación se verifican en la cola `clarification-jobs`: el worker debe estar DETENIDO para que no
 * los consuma (docker compose stop worker).
 *
 * Uso (desde la raíz del repo, con postgres, redis y api levantados y el worker detenido; la API necesita
 * CONFIG_ENCRYPTION_KEY y la prueba JWT_SECRET):
 *   docker compose exec -T api node - < apps/api/test/clarification.e2e.js
 *
 * Crea organizaciones de prueba y las borra al terminar. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Queue } = require('bullmq');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    // respuesta que no es JSON
  }
  return { status: res.status, json, text };
};
async function cookieFor(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}

const APP_ID = String(710000 + crypto.randomInt(1, 99999));
const SECRET = `whsec-${suffix}`;
async function hook(event, payload) {
  const body = JSON.stringify(payload);
  const guid = crypto.randomUUID();
  const res = await fetch(`${BASE}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': guid,
      'user-agent': 'GitHub-Hookshot/e2e',
      'x-github-hook-installation-target-id': APP_ID,
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex'),
    },
    body,
  });
  const row = (await q('SELECT * FROM webhook_deliveries WHERE delivery_guid = $1', [guid]))[0];
  return { status: res.status, row };
}

(async () => {
  const queue = new Queue('clarification-jobs', { connection: { url: process.env.REDIS_URL } });
  const jobs = async () => (await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])).filter((j) => j.data.organizationId === orgA || j.data.organizationId === orgB);
  const hash = await bcrypt.hash('Passw0rd!clar', 10);
  const mkOrg = async (name) => (await q(`INSERT INTO organizations(name, slug) VALUES ($1, $2) RETURNING id`, [name, `${name.toLowerCase()}-${suffix}`]))[0].id;
  const orgA = await mkOrg('ClarA');
  const orgB = await mkOrg('ClarB');
  const mkUser = async (label, org, role) => {
    const email = `${label}-${suffix}@clar.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return { email, id };
  };
  const adminA = await mkUser('adminA', orgA, 'admin');
  const dev1 = await mkUser('dev1', orgA, 'user');
  const member = await mkUser('member', orgA, 'user');
  const stranger = await mkUser('stranger', orgA, 'user');
  const adminB = await mkUser('adminB', orgB, 'admin');

  const D1 = (await q(`INSERT INTO developers(organization_id, github_login, display_name, user_id) VALUES ($1, $2, 'Ana', $3) RETURNING id`, [orgA, `ana-${suffix}`, dev1.id]))[0].id;
  const app = (await q(
    `INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
     VALUES ($1, 'App', $2, $3, 'cid', $4, $4, $5) RETURNING id`,
    [orgA, APP_ID, `slug-${APP_ID}`, encrypt('x'), encrypt(SECRET)],
  ))[0].id;
  const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login, github_app_id) VALUES ($1, $2, 'acme', $3) RETURNING id`, [orgA, 650000 + crypto.randomInt(1, 99999), app]))[0].id;
  const GH_REPO_ID = 890000 + crypto.randomInt(1, 99999);
  const repoA = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, $4) RETURNING id`, [orgA, inst, GH_REPO_ID, `acme-${suffix}/demo`]))[0].id;
  await q('INSERT INTO repository_members(organization_id, repository_id, user_id) VALUES ($1, $2, $3)', [orgA, repoA, member.id]);
  const instB = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'other') RETURNING id`, [orgB, 660000 + crypto.randomInt(1, 99999)]))[0].id;
  const repoB = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, $4) RETURNING id`, [orgB, instB, GH_REPO_ID + 1, `other-${suffix}/demo`]))[0].id;

  let branchSeq = 0;
  const mkRun = async (org, repo, dev) =>
    (await q(
      `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, quality_score, risk_level, gate_decision, developer_id, completed_at)
       VALUES ($1, $2, $3, 'push', 'completed', $4, 70, 'medium', 'requiere_revision', $5, now() - interval '1 hour') RETURNING id`,
      [org, repo, crypto.randomBytes(20).toString('hex'), `feature/c${branchSeq++}`, dev],
    ))[0].id;
  const mkFinding = async (org, run, over = {}) => {
    const id = (await q(
      `INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, line_start, title, explanation, confidence, status, question, clarification_round, blocking)
       VALUES ($1, $2, 'regression', 'high', 'src/a.ts', 1, $3, 'Cambio de contrato.', 0.5, $4, $5, 1, false) RETURNING id`,
      [org, run, over.title ?? 'Contrato cambiado', over.status ?? 'awaiting_clarification', over.status && over.status !== 'awaiting_clarification' ? null : '¿Se actualizó el cliente?'],
    ))[0].id;
    if (!over.status || over.status === 'awaiting_clarification') {
      await q(`INSERT INTO finding_clarifications(organization_id, finding_id, role, body, source) VALUES ($1, $2, 'ai', '¿Se actualizó el cliente?', 'ai')`, [org, id]);
    }
    return id;
  };
  const clar = (id) => q('SELECT role, body, source, author_login, posted_by, github_comment_id FROM finding_clarifications WHERE finding_id = $1 ORDER BY created_at, id', [id]);
  const mkIssue = async (run, branch, number, kind = 'findings') =>
    (await q(
      `INSERT INTO issues(organization_id, repository_id, github_issue_number, branch, review_run_id, kind, origin, title, body, state, first_commit_sha, last_commit_sha)
       VALUES ($1, $2, $3, $4, $5, $6, 'devsentinel', 't', 'b', 'open', 'a', 'a') RETURNING id`,
      [orgA, repoA, number, branch, run, kind],
    ))[0].id;

  try {
    const cAdmin = await cookieFor(adminA.email, 'Passw0rd!clar');
    const cDev = await cookieFor(dev1.email, 'Passw0rd!clar');
    const cMember = await cookieFor(member.email, 'Passw0rd!clar');
    const cStranger = await cookieFor(stranger.email, 'Passw0rd!clar');
    const cAdminB = await cookieFor(adminB.email, 'Passw0rd!clar');

    const run1 = await mkRun(orgA, repoA, D1);
    const F1 = await mkFinding(orgA, run1);
    const F2 = await mkFinding(orgA, run1, { title: 'Ya resuelto', status: 'open' });
    const F3 = await mkFinding(orgA, run1, { title: 'Otra duda' });
    const runB = await mkRun(orgB, repoB, null);
    const FB = await mkFinding(orgB, runB);

    // ================================================================== responder
    const ans = (id, cookie, body) => call(`/dashboard/findings/${id}/clarifications`, cookie, { method: 'POST', body: { body } });
    let r = await ans(F1, null, 'hola');
    check('sin sesión → 401', r.status === 401);
    r = await ans(F1, cStranger, 'hola');
    check('un usuario sin relación con el commit ni el repo → 403 y no escribe nada', r.status === 403 && (await clar(F1)).length === 1);
    r = await ans(F1, cDev, '   ');
    check('respuesta vacía → 400', r.status === 400);
    r = await ans(F1, cDev, 'x'.repeat(4001));
    check('respuesta de más de 4000 caracteres → 400', r.status === 400);
    r = await call(`/dashboard/findings/${F1}/clarifications`, cDev, { method: 'POST', body: { body: 123 } });
    check('cuerpo que no es texto → 400', r.status === 400);
    r = await ans(F2, cDev, 'ya lo arreglé');
    check('hallazgo que no está pendiente → 409', r.status === 409);
    r = await ans(crypto.randomUUID(), cDev, 'hola');
    check('hallazgo inexistente → 404', r.status === 404);
    r = await ans(FB, cAdmin, 'hola');
    check('hallazgo de OTRA organización → 404 (aislamiento por organización)', r.status === 404 && (await clar(FB)).length === 1);
    r = await ans(F1, cAdminB, 'hola');
    check('el admin de otra organización tampoco puede responder → 404', r.status === 404);
    r = await call('/dashboard/findings/no-es-uuid/clarifications', cDev, { method: 'POST', body: { body: 'hola' } });
    check('id mal formado → error de cliente, no 500', r.status >= 400 && r.status < 500, String(r.status));

    r = await ans(F1, cDev, 'Sí, ya actualizamos acme/client (src/client.ts).');
    check('el autor del commit responde → 201 con el mensaje', (r.status === 201 || r.status === 200) && r.json.role === 'developer' && r.json.source === 'platform', r.text);
    let thread = await clar(F1);
    check('queda en la conversación como mensaje del desarrollador (origen: plataforma) con quién lo escribió', thread.length === 2 && thread[1].role === 'developer' && thread[1].author_login === 'dev1' && thread[1].posted_by === dev1.id, JSON.stringify(thread));
    let js = (await jobs()).filter((j) => j.data.findingId === F1);
    check('se encola la re-evaluación (kind=reply) con los ids correctos', js.length === 1 && js[0].data.kind === 'reply' && js[0].data.reviewRunId === run1 && js[0].data.repositoryId === repoA && js[0].data.organizationId === orgA, JSON.stringify(js.map((j) => j.data)));

    await q('UPDATE findings SET needs_human = true WHERE id = $1', [F1]);
    r = await ans(F1, cMember, 'Adjunto más datos: está en el commit abc1234.');
    check('un miembro asignado al repo también puede responder', r.status < 300, r.text);
    check('una respuesta nueva devuelve el hallazgo a la IA (needs_human = false)', (await q('SELECT needs_human FROM findings WHERE id = $1', [F1]))[0].needs_human === false);
    r = await ans(F3, cAdmin, 'Lo reviso yo.');
    check('un admin puede responder cualquier pregunta de su organización', r.status < 300, r.text);

    // ================================================================== lectura
    r = await call(`/dashboard/review-runs/${run1}`, cAdmin);
    const gotF1 = r.json?.findings?.find((f) => f.id === F1);
    check('el commit trae la conversación completa de cada pregunta', r.status === 200 && Array.isArray(r.json.clarifications) && r.json.clarifications.filter((m) => m.finding_id === F1).length === 3, r.text.slice(0, 300));
    check('y los campos de la pregunta en el hallazgo', gotF1?.status === 'awaiting_clarification' && gotF1.question === '¿Se actualizó el cliente?' && gotF1.clarification_round === 1 && gotF1.needs_human === false, JSON.stringify(gotF1));
    r = await call(`/dashboard/review-runs/${run1}`, cStranger);
    check('quien no tiene acceso al commit no ve la conversación → 403', r.status === 403);
    r = await call(`/dashboard/review-runs/${run1}`, cDev);
    check('el autor del commit (developer vinculado a su cuenta) sí puede abrir su análisis aunque no esté asignado al repo', r.status === 200 && r.json.clarifications.filter((m) => m.finding_id === F1).length === 3);
    r = await call(`/dashboard/review-runs/${run1}/diff`, cStranger);
    check('y el diff sigue protegido para quien no tiene acceso', r.status === 403);
    r = await call(`/dashboard/repositories/${repoA}/pushes`, cAdmin);
    const pushRow = (r.json?.items ?? r.json?.runs ?? r.json ?? []).find?.((p) => p.id === run1);
    check('la lista de pushes cuenta las preguntas sin resolver (2: F1 y F3)', r.status === 200 && pushRow?.questions_count === 2, JSON.stringify(pushRow ?? r.text.slice(0, 200)));

    // ================================================================== decisión de un admin
    const decide = (id, cookie, body) => call(`/dashboard/findings/${id}/clarification-decision`, cookie, { method: 'POST', body });
    r = await decide(F3, cDev, { decision: 'dismiss' });
    check('decisión manual: un usuario que no es admin → 403', r.status === 403);
    r = await decide(F3, cAdmin, { decision: 'tal vez' });
    check('decisión inválida → 400', r.status === 400);
    r = await decide(F2, cAdmin, { decision: 'dismiss' });
    check('decisión sobre un hallazgo que ya no está pendiente → 409', r.status === 409);
    r = await decide(FB, cAdmin, { decision: 'dismiss' });
    check('decisión sobre un hallazgo de otra organización → 404', r.status === 404);
    r = await decide(F3, cAdmin, { decision: 'confirm', comment: 'Es real, ya lo revisé.' });
    check('un admin decide → en cola (no cambia nada hasta que el worker lo aplique)', r.status < 300 && r.json?.queued === true && (await q('SELECT status FROM findings WHERE id = $1', [F3]))[0].status === 'awaiting_clarification', r.text);
    js = (await jobs()).filter((j) => j.data.findingId === F3 && j.data.kind === 'manual');
    check('el trabajo manual lleva la decisión, quién la tomó y su comentario', js.length === 1 && js[0].data.manual.decision === 'confirm' && js[0].data.manual.userId === adminA.id && js[0].data.manual.comment === 'Es real, ya lo revisé.', JSON.stringify(js.map((j) => j.data)));

    // ================================================================== respuesta por GitHub
    const FULL = `acme-${suffix}/demo`;
    const repoPayload = { id: GH_REPO_ID, full_name: FULL, owner: { login: `acme-${suffix}` }, default_branch: 'main' };
    const run2 = await mkRun(orgA, repoA, D1);
    const branch2 = (await q('SELECT branch FROM review_runs WHERE id = $1', [run2]))[0].branch;
    const G1 = await mkFinding(orgA, run2, { title: 'Duda GitHub 1' });
    const G2 = await mkFinding(orgA, run2, { title: 'Duda GitHub 2' });
    const G3 = await mkFinding(orgA, run2, { title: 'Ya resuelta', status: 'dismissed_false_positive' });
    const issueNumber = 4000 + crypto.randomInt(1, 900);
    await mkIssue(run2, branch2, issueNumber);
    const issuePayload = (over = {}) => ({
      action: 'created',
      issue: { number: issueNumber, title: 't', body: 'b', state: 'open', user: { login: 'devsentinel[bot]' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      comment: { id: 70000 + crypto.randomInt(1, 9000), body: 'Sí, ya está actualizado en el otro repo.', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      repository: repoPayload,
      installation: { id: 1 },
      ...over,
    });

    let p = issuePayload();
    let h = await hook('issue_comment', p);
    check('comentario de una persona en el issue de seguimiento → procesado como respuesta (clarification_received)', h.status < 300 && h.row.outcome === 'processed' && h.row.reason === 'clarification_received', JSON.stringify(h.row));
    let t1 = await clar(G1);
    let t2 = await clar(G2);
    check('queda como respuesta en TODAS las preguntas pendientes del commit (origen: GitHub, con el id del comentario)', t1.length === 2 && t2.length === 2 && t1[1].source === 'github' && t1[1].author_login === 'ana-gh' && Number(t1[1].github_comment_id) === p.comment.id && t2[1].role === 'developer');
    check('y no se mete en un hallazgo que ya no estaba pendiente', (await clar(G3)).length === 0);
    js = (await jobs()).filter((j) => [G1, G2].includes(j.data.findingId));
    check('se encola una re-evaluación por pregunta', js.length === 2 && js.every((j) => j.data.kind === 'reply' && j.data.reviewRunId === run2));

    h = await hook('issue_comment', p);
    check('el mismo comentario llegando otra vez no duplica nada (idempotente por id de comentario)', (await clar(G1)).length === 2 && (await jobs()).filter((j) => [G1, G2].includes(j.data.findingId)).length === 2, JSON.stringify(h.row));

    p = issuePayload({ comment: { id: 71000 + crypto.randomInt(1, 900), body: 'Esto lo escribió el bot.', user: { login: 'devsentinel[bot]', type: 'Bot' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    h = await hook('issue_comment', p);
    check('un comentario de un bot (la propia App) NO cuenta como respuesta', h.row.reason === 'issue_synced' && (await clar(G1)).length === 2);

    p = issuePayload({ action: 'edited', comment: { id: 72000 + crypto.randomInt(1, 900), body: 'editado', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    h = await hook('issue_comment', p);
    check('un comentario editado no es una respuesta nueva', (await clar(G1)).length === 2);

    p = issuePayload({ comment: { id: 73000 + crypto.randomInt(1, 900), body: '   ', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    await hook('issue_comment', p);
    check('un comentario vacío no cuenta', (await clar(G1)).length === 2);

    // un issue que no es de seguimiento del análisis (manual) no dispara nada
    const manualNumber = issueNumber + 1;
    p = issuePayload({ issue: { number: manualNumber, title: 'manual', body: 'b', state: 'open', user: { login: 'x' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, comment: { id: 74000 + crypto.randomInt(1, 900), body: 'comentario suelto', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    h = await hook('issue_comment', p);
    check('un comentario en un issue que no es de seguimiento de un análisis no es una respuesta', h.row.reason === 'issue_synced' && (await clar(G1)).length === 2);

    // comentario en la conversación del PR
    const run3 = await mkRun(orgA, repoA, D1);
    const H1 = await mkFinding(orgA, run3, { title: 'Duda en el PR' });
    const prNumber = 900 + crypto.randomInt(1, 90);
    await q(
      `INSERT INTO pull_requests(organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, created_by, source_review_run_id)
       VALUES ($1, $2, $3, 'PR', 'feature/pr', 'main', 'ana-gh', 'open', 'github', $4)`,
      [orgA, repoA, prNumber, run3],
    );
    p = {
      action: 'created',
      issue: { number: prNumber, title: 'PR', state: 'open', pull_request: { url: 'x' }, user: { login: 'ana-gh' } },
      comment: { id: 75000 + crypto.randomInt(1, 900), body: 'Respondo desde el PR: sí, ya está.', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString() },
      repository: repoPayload,
      installation: { id: 1 },
    };
    h = await hook('issue_comment', p);
    check('comentario de una persona en la conversación del PR → respuesta a las preguntas del commit', h.row.reason === 'clarification_received' && (await clar(H1)).length === 2 && (await clar(H1))[1].source === 'github', JSON.stringify(h.row));
    check('y se encola la re-evaluación', (await jobs()).filter((j) => j.data.findingId === H1).length === 1);
    p.comment = { ...p.comment, id: p.comment.id + 1, user: { login: 'github-actions[bot]', type: 'Bot' } };
    h = await hook('issue_comment', p);
    check('un bot comentando en el PR no responde nada', (await clar(H1)).length === 2);
    p.comment = { id: p.comment.id + 1, body: 'otro comentario', user: { login: 'ana-gh', type: 'User' }, created_at: new Date().toISOString() };
    p.issue = { ...p.issue, number: prNumber + 5 };
    h = await hook('issue_comment', p);
    check('un comentario en un PR sin preguntas pendientes se ignora como antes (issue_is_pr)', h.row.reason === 'issue_is_pr');
  } finally {
    for (const j of await jobs().catch(() => [])) await j.remove().catch(() => undefined);
    await queue.close();
    await q('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@clar.test`]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
