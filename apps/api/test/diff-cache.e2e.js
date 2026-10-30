/* Pruebas del diff de la página del commit: caché, tope de tamaño sin partir archivos, control de acceso y el estado mínimo de las
 * preguntas de la IA (lo que la pantalla consulta en vez de recargar la página entera).
 *
 * Uso (desde la raíz del repo, con postgres y api levantados; la API necesita GITHUB_API_URL=http://api:4010 y la prueba JWT_SECRET):
 *   docker compose exec -T -e JWT_SECRET=... api node - < apps/api/test/diff-cache.e2e.js
 *
 * Levanta un GitHub simulado en el puerto 4010 DENTRO de este proceso; crea una organización de prueba y la borra al terminar. */
const crypto = require('crypto');
const http = require('http');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { encrypt } = require('@devsentinel/settings');

const { DiffCache, capDiff } = require('/repo/apps/api/dist/modules/dashboard/diffCache.js');
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
const call = async (path, cookie) => {
  const res = await fetch(BASE + path, { headers: { cookie: cookie ?? '', 'x-forwarded-for': randomIp() } });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileDiff = (rel, lines) => [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`, `@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+linea ${i} de ${rel} con algo de texto para que pese`)].join('\n') + '\n';

(async () => {
  // ================================================================== DiffCache (unidad)
  let clock = 1000;
  const cache = new DiffCache(3, 1000, () => clock);
  let loads = 0;
  const load = (v) => async () => {
    loads++;
    await sleep(20);
    return v;
  };
  const [a, b] = await Promise.all([cache.get('k1', 60_000, load('x'.repeat(100))), cache.get('k1', 60_000, load('otro'))]);
  check('caché: dos pedidos simultáneos del mismo diff hacen UNA sola carga', loads === 1 && a === b);
  await cache.get('k1', 60_000, load('nuevo'));
  check('caché: el segundo pedido sale de memoria', loads === 1);
  clock += 61_000;
  const again = await cache.get('k1', 60_000, load('y'.repeat(50)));
  check('caché: vence por tiempo y se vuelve a cargar', loads === 2 && again.startsWith('y'));
  await cache.get('k2', 60_000, load('b'.repeat(50)));
  await cache.get('k3', 60_000, load('c'.repeat(50)));
  await cache.get('k4', 60_000, load('d'.repeat(50)));
  check('caché: respeta el máximo de entradas (3) expulsando la más antigua', cache.size === 3);
  const before = loads;
  await cache.get('k5', 60_000, load('z'.repeat(900)));
  await cache.get('k5', 60_000, load('z'.repeat(900)));
  check('caché: un diff descomunal (más de la mitad del tope total) no se guarda: desalojaría todo lo demás', loads === before + 2 && cache.size <= 3);
  let failedLoad = 0;
  await cache.get('kf', 60_000, async () => { failedLoad++; throw new Error('GitHub caído'); }).catch(() => undefined);
  await cache.get('kf', 60_000, async () => { failedLoad++; return 'ok'; });
  check('caché: un error de GitHub no queda guardado (se reintenta en el siguiente pedido)', failedLoad === 2);

  // ================================================================== capDiff (unidad)
  const d3 = fileDiff('a.ts', 10) + fileDiff('b.ts', 10) + fileDiff('c.ts', 10);
  check('capDiff: un diff que cabe pasa intacto', capDiff(d3, d3.length + 1).truncated === false && capDiff(d3, d3.length + 1).diff === d3);
  const cap = capDiff(d3, fileDiff('a.ts', 10).length + 50);
  check('capDiff: recorta POR ARCHIVOS (nunca parte uno), informa el total y qué quedó fuera', cap.truncated && cap.diff === fileDiff('a.ts', 10) && cap.omittedFiles.join() === 'b.ts,c.ts' && cap.totalChars === d3.length);
  check('capDiff: aunque el primer archivo ya supere el tope se incluye (algo se muestra siempre)', capDiff(d3, 10).diff.startsWith('diff --git a/a.ts') && capDiff(d3, 10).omittedFiles.length === 2);
  const keepCap = capDiff(d3, fileDiff('a.ts', 10).length + 50, new Set(['c.ts']));
  check('capDiff: los archivos con hallazgos (keep) se conservan SIEMPRE aunque ya se llegó al tope; solo se omiten los demás', keepCap.diff === fileDiff('a.ts', 10) + fileDiff('c.ts', 10) && keepCap.omittedFiles.join() === 'b.ts');
  const giant = fileDiff('g.ts', 40_000);
  const capGiant = capDiff(giant + fileDiff('z.ts', 10), 1000, new Set(['g.ts']));
  check('capDiff: un archivo con hallazgos gigante se corta en un salto de línea con aviso (tope por archivo)', capGiant.diff.length < giant.length && /parche recortado por su tamaño/.test(capGiant.diff) && !capGiant.diff.includes('diff --git a/z.ts'));

  // ================================================================== endpoint con GitHub simulado
  let diffCalls = 0;
  let currentDiff = fileDiff('src/a.ts', 20);
  const gh = http.createServer((req, res) => {
    const send = (st, o, t = 'application/json') => { res.writeHead(st, { 'content-type': t }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    if (/access_tokens$/.test(req.url)) return send(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'all' });
    if (req.url.includes('/commits/')) { diffCalls++; return send(200, currentDiff, 'application/vnd.github.v3.diff; charset=utf-8'); }
    send(404, { message: 'mock' });
  });
  await new Promise((r) => gh.listen(4010, '0.0.0.0', r));

  const hash = await bcrypt.hash('Passw0rd!dif', 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Diff', $1) RETURNING id`, [`dif-${suffix}`]))[0].id;
  const mk = async (label, role) => {
    const email = `${label}-${suffix}@dif.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return { email, id };
  };
  const admin = await mk('admin', 'admin');
  const stranger = await mk('stranger', 'user');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const app = (await q(`INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted) VALUES ($1, 'App', $2, 'a', 'c', $3, $4, $5) RETURNING id`, [org, String(530000 + crypto.randomInt(1, 99999)), encrypt('x'), encrypt(privateKey), encrypt('w')]))[0].id;
  const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login, github_app_id) VALUES ($1, $2, 'acme', $3) RETURNING id`, [org, 960000 + crypto.randomInt(1, 99999), app]))[0].id;
  const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/api') RETURNING id`, [org, inst, 991000 + crypto.randomInt(1, 99999)]))[0].id;
  const mkRun = async () => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision, branch) VALUES ($1, $2, $3, 'push', 'completed', 'apto', 'feature/x') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex')]))[0].id;

  try {
    const cAdmin = await cookieFor(admin.email, 'Passw0rd!dif');
    const cStranger = await cookieFor(stranger.email, 'Passw0rd!dif');
    const run1 = await mkRun();

    let r = await call(`/dashboard/review-runs/${run1}/diff`, cAdmin);
    check('diff: devuelve { diff, truncated:false, totalChars, omittedFiles } y el texto llega entero', r.status === 200 && r.json.diff === currentDiff && r.json.truncated === false && r.json.totalChars === currentDiff.length && Array.isArray(r.json.omittedFiles) && r.json.omittedFiles.length === 0, r.text.slice(0, 200));
    check('diff: la primera vez se le pide a GitHub (1 llamada)', diffCalls === 1);
    for (let i = 0; i < 5; i++) await call(`/dashboard/review-runs/${run1}/diff`, cAdmin);
    check('caché: 5 visitas/refrescos más NO vuelven a pedir el diff a GitHub', diffCalls === 1, String(diffCalls));
    currentDiff = fileDiff('src/cambiado.ts', 5);
    r = await call(`/dashboard/review-runs/${run1}/diff`, cAdmin);
    check('caché: el diff de un commit es inmutable, así que sigue sirviendo el guardado', diffCalls === 1 && /src\/a\.ts/.test(r.json.diff));
    const run2 = await mkRun();
    r = await call(`/dashboard/review-runs/${run2}/diff`, cAdmin);
    check('caché: otro commit se pide aparte', diffCalls === 2 && /src\/cambiado\.ts/.test(r.json.diff));

    r = await call(`/dashboard/review-runs/${run1}/diff`, cStranger);
    check('acceso: un usuario sin relación con el repo NO recibe el diff aunque esté en caché → 403', r.status === 403 && !r.text.includes('src/a.ts'));
    r = await call(`/dashboard/review-runs/${run1}/diff`, null);
    check('acceso: sin sesión → 401', r.status === 401);

    // un diff enorme: se recorta por archivos al tope (2 MB por defecto)
    currentDiff = Array.from({ length: 30 }, (_, i) => fileDiff(`src/gen/f${i}.ts`, 2000)).join('');
    const run3 = await mkRun();
    const t0 = Date.now();
    r = await call(`/dashboard/review-runs/${run3}/diff`, cAdmin);
    const ms1 = Date.now() - t0;
    check(`diff enorme (${(currentDiff.length / 1048576).toFixed(1)} MB): llega recortado a ≤ 2 MB, por archivos, con el total y la lista de omitidos`, r.status === 200 && r.json.truncated === true && r.json.diff.length <= 2_000_000 && r.json.totalChars === currentDiff.length && r.json.omittedFiles.length > 0 && r.json.diff.endsWith('\n') && !r.json.diff.includes(r.json.omittedFiles[0]), `${r.json.diff?.length} ${r.json.omittedFiles?.length}`);
    check('diff enorme: cada archivo que llega está completo (el último no queda a medias)', (() => { const files = r.json.diff.split(/^(?=diff --git )/m); return files.every((f) => (f.match(/^\+linea /gm) ?? []).length === 2000); })());
    // los archivos con hallazgos NO se recortan: el último archivo (que normalmente quedaría fuera) tiene un hallazgo
    await q(`INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, line_start, title, explanation, confidence) VALUES ($1, $2, 'best_practice', 'low', 'src/gen/f29.ts', 3, 'Hallazgo en el último archivo', 'x', 0.7)`, [org, run3]);
    const withFinding = await call(`/dashboard/review-runs/${run3}/diff`, cAdmin);
    check('diff enorme: el archivo con un hallazgo llega COMPLETO aunque por tamaño habría quedado fuera, y ya no figura como omitido', withFinding.json.truncated === true && withFinding.json.diff.includes('diff --git a/src/gen/f29.ts') && !withFinding.json.omittedFiles.includes('src/gen/f29.ts') && (withFinding.json.diff.split('diff --git a/src/gen/f29.ts')[1].match(/^\+linea /gm) ?? []).length === 2000);
    const calls3 = diffCalls;
    const t1 = Date.now();
    await call(`/dashboard/review-runs/${run3}/diff`, cAdmin);
    check('diff enorme: la segunda visita sale de memoria (sin GitHub) y es más rápida', diffCalls === calls3 && Date.now() - t1 <= ms1 + 50, `${ms1} ms → ${Date.now() - t1} ms`);

    // ================================================================== estado mínimo de una pregunta de la IA
    const finding = (await q(`INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, line_start, title, explanation, confidence, status, question, clarification_round) VALUES ($1, $2, 'regression', 'high', 'a.ts', 1, 'Duda', 'x', 0.5, 'awaiting_clarification', '¿Ya se actualizó?', 1) RETURNING id`, [org, run1]))[0].id;
    await q(`INSERT INTO finding_clarifications(organization_id, finding_id, role, body, source) VALUES ($1, $2, 'ai', '¿Ya se actualizó?', 'ai')`, [org, finding]);
    r = await call(`/dashboard/findings/${finding}/clarification-state`, cAdmin);
    check('estado de la pregunta: respuesta mínima (estado, ronda, último mensaje, cantidad) sin diff ni hallazgos', r.status === 200 && r.json.status === 'awaiting_clarification' && r.json.round === 1 && r.json.messages === 1 && typeof r.json.last_message_id === 'string' && r.text.length < 400, r.text);
    const lastId = r.json.last_message_id;
    await q(`INSERT INTO finding_clarifications(organization_id, finding_id, role, body, source) VALUES ($1, $2, 'developer', 'Sí', 'platform')`, [org, finding]);
    r = await call(`/dashboard/findings/${finding}/clarification-state`, cAdmin);
    check('estado de la pregunta: un mensaje nuevo cambia last_message_id (es lo que dispara la recarga de la página)', r.json.messages === 2 && r.json.last_message_id !== lastId);
    await q(`UPDATE findings SET status = 'dismissed_false_positive' WHERE id = $1`, [finding]);
    check('estado de la pregunta: al resolverse el estado lo refleja', (await call(`/dashboard/findings/${finding}/clarification-state`, cAdmin)).json.status === 'dismissed_false_positive');
    check('estado de la pregunta: sin acceso → 403; inexistente → 404; id mal formado → 400; sin sesión → 401', (await call(`/dashboard/findings/${finding}/clarification-state`, cStranger)).status === 403 && (await call(`/dashboard/findings/${crypto.randomUUID()}/clarification-state`, cAdmin)).status === 404 && (await call('/dashboard/findings/no-es-uuid/clarification-state', cAdmin)).status === 400 && (await call(`/dashboard/findings/${finding}/clarification-state`, null)).status === 401);
  } finally {
    gh.close();
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@dif.test`]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
