/* Pruebas del aviso en vivo de análisis terminados (GET /notifications/stream, SSE) y de la configuración del tono por
 * desarrollador (GET /notifications/sounds, PATCH /dashboard/developers/:id).
 *
 * Uso (desde la raíz del repo, con postgres y api levantados; la API con NOTIFY_POLL_MS=500 y NOTIFY_PING_MS=2000 para
 * que la prueba sea rápida, y JWT_SECRET en el contenedor):
 *   docker compose exec -T api node - < apps/api/test/notifications.e2e.js
 *
 * Crea organizaciones de prueba y las borra al terminar. */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** Cliente SSE mínimo: abre el stream y junta los eventos que llegan. */
async function openStream(cookie) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/notifications/stream', { headers: { cookie, accept: 'text/event-stream', 'x-forwarded-for': randomIp() }, signal: ctrl.signal });
  const stream = { status: res.status, events: [], done: false, contentType: res.headers.get('content-type') ?? '' };
  if (res.status !== 200) return stream;
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { type: 'message', id: null, data: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev.type = line.slice(6).trim();
            else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('data:')) ev.data = JSON.parse(line.slice(5));
          }
          stream.events.push(ev);
        }
      }
    } catch {
      // cierre por abort
    }
    stream.done = true;
  })();
  stream.close = () => ctrl.abort();
  stream.reviews = () => stream.events.filter((e) => e.type === 'review').map((e) => e.data);
  stream.waitFor = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = stream.reviews().find(pred);
      if (found) return found;
      await sleep(100);
    }
    return null;
  };
  return stream;
}

(async () => {
  const hash = await bcrypt.hash('Passw0rd!ntf', 10);
  const mkOrg = async (name) => (await q(`INSERT INTO organizations(name, slug) VALUES ($1, $2) RETURNING id`, [name, `${name.toLowerCase()}-${suffix}`]))[0].id;
  const orgA = await mkOrg('NtfA');
  const orgB = await mkOrg('NtfB');
  const mkUser = async (label, org, role) => {
    const email = `${label}-${suffix}@ntf.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return { email, id };
  };
  const adminA = await mkUser('adminA', orgA, 'admin');
  const dev1 = await mkUser('dev1', orgA, 'user');
  const dev2 = await mkUser('dev2', orgA, 'user');
  const plain = await mkUser('plain', orgA, 'user');
  const adminB = await mkUser('adminB', orgB, 'admin');

  const mkDev = async (org, name, userId, sound, volume, muted) =>
    (await q(
      `INSERT INTO developers(organization_id, github_login, display_name, user_id, notification_sound, notification_volume, notification_muted)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [org, `${name}-${suffix}`, name, userId, sound, volume, muted],
    ))[0].id;
  const D1 = await mkDev(orgA, 'Ana Dev', dev1.id, 'ding', 0.5, false);
  const D2 = await mkDev(orgA, 'Luis Dev', dev2.id, null, 0.8, false);
  const D3 = await mkDev(orgA, 'Externo', null, 'moneda', 0.3, true);
  const DB = await mkDev(orgB, 'Otro Dev', null, null, 0.8, false);

  const mkRepo = async (org, name) => {
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 970000 + crypto.randomInt(1, 99999)]))[0].id;
    return (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, $4) RETURNING id`, [org, inst, 997000 + crypto.randomInt(1, 99999), name]))[0].id;
  };
  const repoA = await mkRepo(orgA, `acme-${suffix}/demo`);
  const repoB = await mkRepo(orgB, `other-${suffix}/demo`);
  const prA = (await q(
    `INSERT INTO pull_requests(organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, created_by)
     VALUES ($1, $2, 77, 'PR de prueba', 'feature/x', 'main', 'dev', 'open', 'github') RETURNING id`,
    [orgA, repoA],
  ))[0].id;

  const run = async ({ org = orgA, repo = repoA, dev = null, status = 'completed', gate = 'apto', score = 90, branch = 'feature/x', trigger = 'push', pr = null, author = null, completedAt = 'now()' }) =>
    (await q(
      `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, quality_score, risk_level, gate_decision, developer_id, author_name, pull_request_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'low', $8, $9, $10, $11, ${completedAt}) RETURNING id`,
      [org, repo, crypto.randomBytes(20).toString('hex'), trigger, status, branch, score, gate, dev, author, pr],
    ))[0].id;

  try {
    const cAdmin = await cookieFor(adminA.email, 'Passw0rd!ntf');
    const c1 = await cookieFor(dev1.email, 'Passw0rd!ntf');
    const c2 = await cookieFor(dev2.email, 'Passw0rd!ntf');
    const cPlain = await cookieFor(plain.email, 'Passw0rd!ntf');
    const cAdminB = await cookieFor(adminB.email, 'Passw0rd!ntf');
    check('login de prueba', [cAdmin, c1, c2, cPlain, cAdminB].every(Boolean));

    // ---------------------------------------------------------------- catálogo y configuración
    check('el stream exige sesión → 401', (await openStream('')).status === 401);
    let r = await call('/notifications/sounds', c1);
    check('catálogo de tonos: lo ve cualquier usuario, trae el tono por defecto y la opción sin sonido', r.status === 200 && r.json.default === 'campana' && r.json.sounds.length === 9 && r.json.sounds.some((s) => s.id === 'silencio') && r.json.sounds.every((s) => s.id && s.label), r.text);
    const patch = (id, body, cookie = cAdmin) => call(`/dashboard/developers/${id}`, cookie, { method: 'PATCH', body });
    r = await patch(D2, { sound: 'arpegio', volume: 0.65, muted: false });
    check('el admin asigna tono y volumen a un desarrollador', r.status === 200 && r.json.notification_sound === 'arpegio' && r.json.notification_volume === 0.65, r.text);
    r = await call('/dashboard/developers', cAdmin);
    const row = r.json.find((d) => d.id === D2);
    check('la lista de developers trae su tono, volumen, silencio y cuenta vinculada', row.notification_sound === 'arpegio' && row.notification_volume === 0.65 && row.notification_muted === false && row.user_email === dev2.email, JSON.stringify(row));
    r = await patch(D2, { sound: null });
    check('sound null vuelve al tono por defecto sin tocar el volumen', r.json.notification_sound === null && r.json.notification_volume === 0.65);
    for (const [label, body] of [['tono inexistente', { sound: 'trompeta' }], ['volumen > 1', { volume: 1.5 }], ['volumen negativo', { volume: -0.1 }], ['volumen que no es número', { volume: '0.5' }], ['muted que no es booleano', { muted: 'si' }]]) {
      const x = await patch(D2, body);
      check(`configuración inválida (${label}) → 400`, x.status === 400, x.text.slice(0, 100));
    }
    check('un desarrollador inexistente → 404', (await patch(crypto.randomUUID(), { muted: true })).status === 404);
    check('un id que no es UUID → 400', (await patch('no-es-uuid', { muted: true })).status === 400);
    check('un usuario no admin no puede cambiarlo → 403', (await patch(D2, { muted: true }, c2)).status === 403);
    check('un admin de OTRA organización no puede tocar el desarrollador → 404', (await patch(D2, { muted: true }, cAdminB)).status === 404 && (await q('SELECT notification_muted FROM developers WHERE id = $1', [D2]))[0].notification_muted === false);
    await patch(D2, { volume: 0.8 });

    // ---------------------------------------------------------------- conexiones
    const sAdmin = await openStream(cAdmin);
    const s1 = await openStream(c1);
    const s2 = await openStream(c2);
    const sPlain = await openStream(cPlain);
    const sAdminB = await openStream(cAdminB);
    await sleep(800);
    check('las conexiones se abren como text/event-stream y reciben "ready" con su rol', [sAdmin, s1, s2, sPlain, sAdminB].every((s) => s.status === 200 && /text\/event-stream/.test(s.contentType)) && sAdmin.events.some((e) => e.type === 'ready' && e.data.role === 'admin') && s1.events.some((e) => e.type === 'ready' && e.data.role === 'user'), JSON.stringify(sAdmin.events));
    await sleep(2500);
    check('llega un "ping" periódico para mantener viva la conexión', sAdmin.events.some((e) => e.type === 'ping'));

    // ---------------------------------------------------------------- reparto
    const run1 = await run({ dev: D1, gate: 'apto', score: 91 });
    const ev1 = await sAdmin.waitFor((e) => e.reviewRunId === run1);
    check('el admin recibe el análisis terminado, con repo, rama, veredicto, score y autor', ev1 && ev1.type === 'review_completed' && ev1.repository === `acme-${suffix}/demo` && ev1.branch === 'feature/x' && ev1.gate === 'apto' && ev1.score === 91 && ev1.author.name === 'Ana Dev', JSON.stringify(ev1));
    check('el evento lleva el tono DEL AUTOR (ding, volumen 0.5)', ev1.sound.id === 'ding' && ev1.sound.volume === 0.5 && ev1.sound.muted === false, JSON.stringify(ev1.sound));
    check('el desarrollador autor lo recibe en su sesión, con su propio tono', !!(await s1.waitFor((e) => e.reviewRunId === run1)) && s1.reviews().find((e) => e.reviewRunId === run1).sound.id === 'ding');
    await sleep(1500);
    check('otro desarrollador, un usuario sin vincular y otra organización NO lo reciben', ![s2, sPlain, sAdminB].some((s) => s.reviews().some((e) => e.reviewRunId === run1)));

    const run2 = await run({ dev: D2, gate: 'requiere_revision', score: 72, trigger: 'push' });
    const ev2 = await sAdmin.waitFor((e) => e.reviewRunId === run2);
    check('un desarrollador sin tono asignado suena con el tono por defecto (campana)', ev2 && ev2.sound.id === 'campana' && ev2.gate === 'requiere_revision', JSON.stringify(ev2));
    check('lo recibe su dueño y el otro desarrollador no', !!(await s2.waitFor((e) => e.reviewRunId === run2)) && !s1.reviews().some((e) => e.reviewRunId === run2));

    const run3 = await run({ dev: D3, gate: 'no_apto', score: 40 });
    const ev3 = await sAdmin.waitFor((e) => e.reviewRunId === run3);
    check('un desarrollador silenciado: el evento llega con muted=true y su tono (el navegador decide no sonar)', ev3 && ev3.sound.muted === true && ev3.sound.id === 'moneda' && ev3.gate === 'no_apto', JSON.stringify(ev3));
    await sleep(1200);
    check('un desarrollador sin cuenta vinculada solo lo oye el admin', ![s1, s2, sPlain].some((s) => s.reviews().some((e) => e.reviewRunId === run3)));

    const run4 = await run({ dev: null, author: 'Autor Externo', gate: 'apto' });
    const ev4 = await sAdmin.waitFor((e) => e.reviewRunId === run4);
    check('un commit de un autor desconocido llega con el tono por defecto y el nombre del commit', ev4 && ev4.sound.id === 'campana' && ev4.author.name === 'Autor Externo' && ev4.author.developerId === null, JSON.stringify(ev4));

    const run5 = await run({ dev: D1, status: 'failed', gate: null, score: null });
    const ev5 = await sAdmin.waitFor((e) => e.reviewRunId === run5);
    check('un análisis que falla definitivamente llega como review_failed', ev5 && ev5.type === 'review_failed' && ev5.gate === null, JSON.stringify(ev5));

    const run6 = await run({ dev: D1, trigger: 'pull_request', pr: prA, branch: null });
    const ev6 = await sAdmin.waitFor((e) => e.reviewRunId === run6);
    check('el análisis de un Pull Request trae su número', ev6 && ev6.trigger === 'pull_request' && ev6.prNumber === 77, JSON.stringify(ev6));

    // en curso → no avisa; al terminar sí (así ocurre en la realidad: primero "running", luego se completa)
    const run7 = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, developer_id) VALUES ($1, $2, $3, 'push', 'running', 'feature/y', $4) RETURNING id`, [orgA, repoA, crypto.randomBytes(20).toString('hex'), D1]))[0].id;
    await sleep(1500);
    check('un análisis en curso no avisa', !sAdmin.reviews().some((e) => e.reviewRunId === run7));
    await q(`UPDATE review_runs SET status = 'completed', completed_at = now(), gate_decision = 'apto', quality_score = 88 WHERE id = $1`, [run7]);
    check('al terminar, avisa', !!(await sAdmin.waitFor((e) => e.reviewRunId === run7)));
    await q(`INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, title, explanation, blocking) VALUES ($1, $2, 'security', 'high', 'a.ts', 't', 'e', true)`, [orgA, run7]);
    await q('UPDATE review_runs SET quality_score = 70 WHERE id = $1', [run7]);
    await sleep(1800);
    check('un análisis ya avisado no se repite aunque se modifique', sAdmin.reviews().filter((e) => e.reviewRunId === run7).length === 1);

    // Como en la realidad: el análisis está en curso, se guardan sus hallazgos y recién entonces se marca como terminado
    const run8 = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, developer_id) VALUES ($1, $2, $3, 'push', 'running', 'feature/z', $4) RETURNING id`, [orgA, repoA, crypto.randomBytes(20).toString('hex'), D1]))[0].id;
    await q(`INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, title, explanation, blocking) VALUES ($1, $2, 'security', 'critical', 'a.ts', 't', 'e', true), ($1, $2, 'regression', 'high', 'b.ts', 't2', 'e2', true), ($1, $2, 'clean_code', 'low', 'c.ts', 't3', 'e3', false)`, [orgA, run8]);
    await q(`UPDATE review_runs SET status = 'completed', completed_at = now(), gate_decision = 'no_apto', quality_score = 30 WHERE id = $1`, [run8]);
    const ev8 = await sAdmin.waitFor((e) => e.reviewRunId === run8);
    check('el aviso trae el número de hallazgos bloqueantes (solo los bloqueantes)', ev8 && ev8.blockingCount === 2 && ev8.gate === 'no_apto', JSON.stringify(ev8));

    const old = await run({ dev: D1, completedAt: `now() - interval '5 minutes'` });
    await sleep(1800);
    check('un análisis que terminó ANTES de conectarse no se anuncia', !sAdmin.reviews().some((e) => e.reviewRunId === old));

    const runB = await run({ org: orgB, repo: repoB, dev: DB });
    check('la otra organización oye solo lo suyo', !!(await sAdminB.waitFor((e) => e.reviewRunId === runB))) ;
    await sleep(800);
    check('y el admin de la primera organización NO oye lo de la otra', !sAdmin.reviews().some((e) => e.reviewRunId === runB));

    // ---------------------------------------------------------------- perfil propio
    r = await call('/dashboard/me/profile', c1);
    check('"Mi perfil" del desarrollador incluye su tono', r.status === 200 && r.json.notification_sound === 'ding' && r.json.notification_muted === false, r.text);

    // ---------------------------------------------------------------- cierre por vencimiento de sesión
    const shortCookie = `session=${jwt.sign({ sub: adminA.id, orgId: orgA, amr: 'pwd', sv: 0, at: Math.floor(Date.now() / 1000) }, process.env.JWT_SECRET, { expiresIn: 3 })}`;
    const sShort = await openStream(shortCookie);
    check('con un token que vence en segundos el stream abre', sShort.status === 200);
    await sleep(5500);
    check('el stream se cierra solo cuando vence la sesión (el navegador reconecta con la cookie renovada)', sShort.done === true);
    const reopened = await openStream(shortCookie);
    check('reconectar con la sesión ya vencida → 401 (no se queda escuchando)', reopened.status === 401);

    for (const s of [sAdmin, s1, s2, sPlain, sAdminB, sShort]) s.close?.();
  } finally {
    // primero las organizaciones (arrastran a los developers que referencian a los usuarios) y luego los usuarios
    await q('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@ntf.test`]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
