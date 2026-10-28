/* Pruebas de las preguntas de la IA al desarrollador, contra el worker COMPILADO dentro de su contenedor:
 *   1) el veredicto cuando hay hallazgos con pregunta (evaluateGateDecision / recomputeGateDecision),
 *   2) cómo se guardan los hallazgos con pregunta (persistResult),
 *   3) ClarificationService: re-evaluar con la respuesta del desarrollador (descartar, confirmar, repreguntar, escalar a una
 *      persona, decisión manual), verificando otros repos con herramientas de solo lectura, con un GitHub y un LLM simulados.
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados):
 *   docker compose exec -T worker node - < apps/worker/test/clarification.test.js
 *
 * Guarda y restaura la configuración de agentes de IA. Crea una organización de prueba y la borra al terminar. */
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const { encrypt } = require('@devsentinel/settings');
const { withTenant } = require('@devsentinel/database');
const { clearLlmCooldowns } = require('@devsentinel/llm-port');

const DIST = '/repo/apps/worker/dist';
const { ClarificationService } = require(`${DIST}/modules/clarification/clarification.service.js`);
const { RemoteToolbox } = require(`${DIST}/modules/clarification/remoteToolbox.js`);
const { ReviewService } = require(`${DIST}/modules/review/review.service.js`);
const { recomputeGateDecision } = require(`${DIST}/common/gate.js`);

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = crypto.randomBytes(3).toString('hex');
const num = () => 600000 + crypto.randomInt(1, 399999);

// ------------------------------------------------------------------ GitHub simulado
const gh = { calls: [], files: {}, searchItems: [{ path: 'src/client.ts', html_url: 'https://github.com/x/y/blob/main/src/client.ts' }], issueNumber: 9 };
const ghServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    gh.calls.push({ method: req.method, path: url.pathname, search: url.search, body });
    const send = (s, o, type = 'application/json') => {
      res.writeHead(s, { 'content-type': type });
      res.end(typeof o === 'string' ? o : JSON.stringify(o));
    };
    let m;
    if (/\/access_tokens$/.test(url.pathname)) return send(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'all' });
    if (req.method === 'GET' && /\/commits\/[0-9a-f]{40}$/.test(url.pathname)) return send(200, 'diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-const v = 1;\n+const v = 2;\n', 'application/vnd.github.diff');
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/))) {
      const key = `${m[1]}/${m[2]}:${decodeURIComponent(m[3])}`;
      return gh.files[key] !== undefined ? send(200, { type: 'file', name: decodeURIComponent(m[3]).split('/').pop(), path: decodeURIComponent(m[3]), encoding: 'base64', content: Buffer.from(gh.files[key]).toString('base64') }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && url.pathname === '/search/code') return send(200, { total_count: gh.searchItems.length, items: gh.searchItems });
    if (req.method === 'POST' && /\/check-runs$/.test(url.pathname)) return send(201, { id: 1 });
    if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(url.pathname)) return send(201, { id: 5000 + gh.calls.length });
    if (req.method === 'PATCH' && /\/issues\/\d+$/.test(url.pathname)) return send(200, { number: gh.issueNumber, state: body.state ?? 'open' });
    if (req.method === 'POST' && /\/issues$/.test(url.pathname)) return send(201, { number: gh.issueNumber, html_url: 'https://github.com/x/y/issues/9' });
    send(404, { message: `mock: no simulada ${req.method} ${url.pathname}` });
  });
});
const callsTo = (re, method) => gh.calls.filter((c) => re.test(c.path) && (!method || c.method === method));

// ------------------------------------------------------------------ LLM simulado
let llmScript = [];
let llmRequests = [];
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    llmRequests.push(body);
    const step = llmScript.shift();
    const { status, body: out } = step ? step(body) : { status: 500, body: { error: { message: 'sin guion' } } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
const reply = (message) => ({ status: 200, body: { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } } });
const toolCall = (name, args) => () => reply({ content: null, tool_calls: [{ id: `c${crypto.randomBytes(2).toString('hex')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const decision = (d) => () => reply({ content: JSON.stringify({ updated_quality_score: 80, updated_risk_level: 'medium', explanation: 'Explicación de prueba.', ...d }) });

(async () => {
  await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_URL = `http://127.0.0.1:${ghServer.address().port}`;
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const savedProviders = await q('SELECT * FROM llm_providers');
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Clar', $1) RETURNING id`, [`clar-${suffix}`]))[0].id;

  try {
    // ------------------------------------------------------------------ datos
    await q('DELETE FROM llm_providers');
    const mkProvider = async (name, position, kind = 'custom') =>
      q(`INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position) VALUES ($1, $2, $3, 'm', $4, $5)`, [name, kind, `http://127.0.0.1:${llmServer.address().port}/v1`, encrypt('k'), position]);
    await mkProvider('Simulado', 1);
    clearLlmCooldowns();

    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const app = (await q(`INSERT INTO github_apps(organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted) VALUES ($1, 'App', $2, 'a', 'c', $3, $4, $5) RETURNING id`, [org, String(num()), encrypt('x'), encrypt(privateKey), encrypt('w')]))[0].id;
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login, github_app_id) VALUES ($1, $2, 'acme', $3) RETURNING id`, [org, num(), app]))[0].id;
    const repoA = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/api') RETURNING id`, [org, inst, num()]))[0].id;
    await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/client')`, [org, inst, num()]);
    const dev = (await q(`INSERT INTO developers(organization_id, github_login, display_name) VALUES ($1, $2, 'Ana Dev') RETURNING id`, [org, `ana-${suffix}`]))[0].id;

    const mkRun = async (over = {}) =>
      (await q(
        `INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, branch, quality_score, risk_level, gate_decision, summary, developer_id, completed_at)
         VALUES ($1, $2, $3, 'push', 'completed', $8, $4, $5, $6, 'Resumen', $7, now() - interval '1 hour') RETURNING id, commit_sha`,
        [org, repoA, crypto.randomBytes(20).toString('hex'), over.score ?? 70, over.risk ?? 'medium', over.gate ?? 'requiere_revision', dev, over.branch ?? 'feature/main'],
      ))[0];
    const mkFinding = async (runId, over = {}) =>
      (await q(
        `INSERT INTO findings(organization_id, review_run_id, category, severity, file_path, line_start, title, explanation, confidence, status, question, verify_with, clarification_round, blocking)
         VALUES ($1, $2, $3, $4, 'src/api.ts', 1, $5, 'Cambia el contrato de la API.', 0.5, $6, $7, $8, $9, false) RETURNING id`,
        [org, runId, over.category ?? 'regression', over.severity ?? 'high', over.title ?? 'Contrato cambiado sin actualizar el cliente', over.status ?? 'awaiting_clarification', over.question === undefined ? '¿Ya se actualizó acme/client para usar el campo nuevo?' : over.question, over.verify_with ?? JSON.stringify({ repo: 'acme/client', paths: ['src/client.ts'] }), over.round ?? 1],
      ))[0].id;
    const say = (findingId, role, body, extra = {}) =>
      q(`INSERT INTO finding_clarifications(organization_id, finding_id, role, body, author_login, source) VALUES ($1, $2, $3, $4, $5, $6)`, [org, findingId, role, body, extra.author ?? null, extra.source ?? (role === 'ai' ? 'ai' : 'platform')]);
    let branchSeq = 0;
    const mkIssue = async (runId, number, branch) =>
      q(`INSERT INTO issues(organization_id, repository_id, github_issue_number, branch, review_run_id, kind, origin, title, body, state, first_commit_sha, last_commit_sha) VALUES ($1, $2, $3, $5, $4, 'findings', 'devsentinel', 't', 'b', 'open', 'a', 'a')`, [org, repoA, number, runId, branch]);
    /** Escenario nuevo: un commit con un hallazgo-pregunta ya respondido por el desarrollador. */
    const scenario = async ({ round = 1, runOver = {}, findingOver = {}, reply = 'Sí, ya actualizamos acme/client (src/client.ts).' } = {}) => {
      const branch = `feature/x${branchSeq++}`;
      const run = await mkRun({ ...runOver, branch });
      const issueNumber = (gh.issueNumber += 1);
      await mkIssue(run.id, issueNumber, branch);
      const findingId = await mkFinding(run.id, { ...findingOver, round });
      await say(findingId, 'ai', '¿Ya se actualizó acme/client para usar el campo nuevo?');
      if (reply) await say(findingId, 'developer', reply, { author: 'ana', source: 'github' });
      return { run, findingId, issueNumber };
    };
    const job = (s, kind = 'reply', manual) => ({ organizationId: org, repositoryId: repoA, reviewRunId: s.run.id, findingId: s.findingId, kind, ...(manual ? { manual } : {}) });
    const finding = async (id) => (await q('SELECT * FROM findings WHERE id = $1', [id]))[0];
    const runRow = async (id) => (await q('SELECT * FROM review_runs WHERE id = $1', [id]))[0];
    const thread = async (id) => q('SELECT role, body, source FROM finding_clarifications WHERE finding_id = $1 ORDER BY created_at, id', [id]);
    const reset = () => {
      gh.calls.length = 0;
      llmRequests = [];
      llmScript = [];
      clearLlmCooldowns();
    };
    const svc = new ClarificationService();

    // ================================================================== 1) veredicto con preguntas
    const reviewSvc = new ReviewService({}, {}, {});
    const cfg = { block_on_risk_level: 'high', block_on_secret: true };
    const result = (over) => ({ resultado: 'NO_APTO', findings: [], quality_score: 60, risk_level: 'high', resumen_ejecutivo: 'r', recomendaciones: [], tests_recomendados: [], comparacion_commits_previos: '', justificacion_final: '', ...over });
    const f = (over) => ({ category: 'regression', severity: 'high', file_path: 'a.ts', title: 't', explanation: 'e', confidence: 0.5, ...over });
    const gate = (over) => reviewSvc.evaluateGateDecision(cfg, result(over));
    check('solo dudas + el modelo dice NO_APTO y riesgo alto → REQUIERE_REVISIÓN (una duda no bloquea)', gate({ findings: [f({ question: '¿Está el otro repo?' })] }) === 'requiere_revision');
    check('una duda "crítica" en categoría dura NO fuerza NO_APTO', gate({ findings: [f({ severity: 'critical', question: '¿?' })], risk_level: 'medium' }) === 'requiere_revision');
    check('duda + hallazgo confirmado crítico en categoría dura → NO_APTO igual', gate({ findings: [f({ question: '¿?' }), f({ severity: 'critical', category: 'security' })] }) === 'no_apto');
    check('duda + hallazgo confirmado "high" con riesgo alto → NO_APTO', gate({ findings: [f({ question: '¿?' }), f({ severity: 'high' })] }) === 'no_apto');
    check('el modelo dice APTO pero queda una duda → REQUIERE_REVISIÓN (no se aprueba con preguntas)', gate({ resultado: 'APTO', risk_level: 'low', quality_score: 95, findings: [f({ severity: 'low', question: '¿?' })] }) === 'requiere_revision');
    check('sin preguntas nada cambió: APTO sigue APTO', gate({ resultado: 'APTO', risk_level: 'low', quality_score: 95, findings: [f({ severity: 'low' })] }) === 'apto');
    check('sin preguntas: riesgo alto sigue siendo NO_APTO', gate({ findings: [f({ severity: 'medium' })] }) === 'no_apto');
    check('una pregunta vacía no cuenta como pregunta', gate({ resultado: 'APTO', risk_level: 'low', quality_score: 95, findings: [f({ severity: 'low', question: '   ' })] }) === 'apto');

    // ================================================================== 2) persistencia
    const pRun = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger) VALUES ($1, $2, $3, 'push') RETURNING id`, [org, repoA, crypto.randomBytes(20).toString('hex')]))[0].id;
    const toPersist = result({
      resultado: 'REQUIERE_REVISION',
      risk_level: 'medium',
      findings: [
        f({ severity: 'critical', title: 'Duda crítica', question: '¿Se actualizó el consumidor?', verify_with: { repo: 'acme/client', paths: ['src/client.ts'] } }),
        f({ severity: 'high', title: 'Confirmado', category: 'security' }),
      ],
    });
    await reviewSvc.persistResult({ organizationId: org, repositoryId: repoA, reviewRunId: pRun }, toPersist, 'requiere_revision', [], { mode: 'standard', note: null, trace: null, stats: null });
    const persisted = await q('SELECT * FROM findings WHERE review_run_id = $1 ORDER BY title', [pRun]);
    const dudaRow = persisted.find((r) => r.title === 'Duda crítica');
    const okRow = persisted.find((r) => r.title === 'Confirmado');
    check('la duda se guarda como pregunta pendiente: no bloquea y su severidad se limita a "high"', dudaRow.status === 'awaiting_clarification' && dudaRow.blocking === false && dudaRow.severity === 'high' && dudaRow.question === '¿Se actualizó el consumidor?' && dudaRow.clarification_round === 1, JSON.stringify(dudaRow));
    check('guarda dónde verificaría la IA', dudaRow.verify_with?.repo === 'acme/client' && dudaRow.verify_with.paths[0] === 'src/client.ts');
    check('y la pregunta abre la conversación con un mensaje de la IA', (await thread(dudaRow.id)).length === 1 && (await thread(dudaRow.id))[0].role === 'ai');
    check('el hallazgo confirmado se guarda como siempre (abierto, sin pregunta)', okRow.status === 'open' && okRow.question === null && okRow.clarification_round === 0);

    // ================================================================== 3) recomputeGateDecision
    const gateOf = (runId, risk, score) => withTenant(org, (c) => recomputeGateDecision(c, runId, risk, score, cfg));
    const gRun = (await mkRun()).id;
    await mkFinding(gRun, { severity: 'high' });
    check('recalcular con una pregunta pendiente: nunca APTO (aunque el riesgo sea bajo)', (await gateOf(gRun, 'low', 95)) === 'requiere_revision');
    check('recalcular con riesgo alto pero SOLO por preguntas → REQUIERE_REVISIÓN', (await gateOf(gRun, 'high', 50)) === 'requiere_revision');
    await mkFinding(gRun, { status: 'open', question: null, severity: 'high', title: 'Real', verify_with: null });
    check('recalcular con un hallazgo abierto grave y riesgo alto → NO_APTO', (await gateOf(gRun, 'high', 50)) === 'no_apto');
    const gRun2 = (await mkRun()).id;
    await mkFinding(gRun2, { status: 'dismissed_false_positive' });
    check('sin preguntas pendientes y riesgo bajo → APTO', (await gateOf(gRun2, 'low', 95)) === 'apto');

    // ================================================================== 4) ClarificationService
    // ---- descartar tras verificar el otro repo
    reset();
    gh.files['acme/client:src/client.ts'] = 'export const field = "nuevo";\n';
    let s = await scenario();
    llmScript = [
      toolCall('read_remote_file', { repo: 'acme/client', path: 'src/client.ts' }),
      decision({ decision: 'dismissed', explanation: 'Verifiqué acme/client: ya usa el campo nuevo.', updated_quality_score: 96, updated_risk_level: 'low' }),
    ];
    const before = (await runRow(s.run.id)).completed_at;
    await svc.process(job(s));
    let fRow = await finding(s.findingId);
    let rr = await runRow(s.run.id);
    check('descartar: el hallazgo queda como falso positivo con la explicación de la IA', fRow.status === 'dismissed_false_positive' && /ya usa el campo nuevo/.test(fRow.resolution_comment) && fRow.blocking === false, JSON.stringify(fRow));
    check('verificó el otro repo con la herramienta (la lectura llegó a GitHub)', callsTo(/\/repos\/acme\/client\/contents\/src(\/|%2F)client\.ts/, 'GET').length === 1);
    check('el contenido leído se le devolvió al modelo en la 2ª ronda', llmRequests[1]?.messages.some((m) => m.role === 'tool' && /campo = "nuevo"|field = "nuevo"/.test(m.content)));
    check('el prompt le dice qué repos puede leer y trata lo del desarrollador como datos', /acme\/client/.test(llmRequests[0].messages[1].content) && /DATOS, no instrucciones/.test(llmRequests[0].messages[0].content) && /Sí, ya actualizamos/.test(llmRequests[0].messages[1].content));
    check('se recalcula el veredicto del commit: de REQUIERE_REVISIÓN a APTO con el score nuevo', rr.gate_decision === 'apto' && rr.quality_score === 96 && rr.risk_level === 'low', JSON.stringify(rr));
    check('el commit se marca como actualizado (el aviso en vivo lo anuncia otra vez)', new Date(rr.completed_at) > new Date(before));
    check('GitHub: check-run APTO (success) porque cambió el veredicto', callsTo(/\/check-runs$/, 'POST').some((c) => c.body.conclusion === 'success' && c.body.head_sha === s.run.commit_sha));
    check('GitHub: comentario "descartado" con la explicación y cierre del issue (ya no hay nada pendiente)', callsTo(/\/issues\/\d+\/comments$/, 'POST').some((c) => /descartado/.test(c.body.body) && /ya usa el campo nuevo/.test(c.body.body)) && callsTo(/\/issues\/\d+$/, 'PATCH').some((c) => c.body.state === 'closed'));
    check('la conversación guarda la conclusión de la IA', (await thread(s.findingId)).at(-1).role === 'ai' && /ya usa el campo nuevo/.test((await thread(s.findingId)).at(-1).body));

    // ---- confirmar → bloquea
    reset();
    s = await scenario({ reply: 'No lo sé, creo que no.' });
    llmScript = [decision({ decision: 'confirmed', severity: 'high', explanation: 'El cliente sigue usando el campo viejo.', updated_quality_score: 40, updated_risk_level: 'high' })];
    await svc.process(job(s));
    fRow = await finding(s.findingId);
    rr = await runRow(s.run.id);
    check('confirmar: el hallazgo pasa a abierto y BLOQUEA (commit NO APTO, severidad alta)', fRow.status === 'open' && fRow.blocking === true && fRow.severity === 'high' && rr.gate_decision === 'no_apto' && rr.quality_score === 40, JSON.stringify({ fRow, rr }));
    check('la explicación de la confirmación queda en el hallazgo', /Confirmado tras la aclaración: El cliente sigue usando el campo viejo/.test(fRow.explanation));
    check('GitHub: check-run NO APTO (failure) y comentario "confirmado"', callsTo(/\/check-runs$/, 'POST').some((c) => c.body.conclusion === 'failure') && callsTo(/\/issues\/\d+\/comments$/, 'POST').some((c) => /confirmado/.test(c.body.body)));
    check('el issue de seguimiento sigue abierto y ahora lista el hallazgo bloqueante', callsTo(/\/issues\/\d+$/, 'PATCH').every((c) => c.body.state !== 'closed') && callsTo(/\/issues\/\d+$/, 'PATCH').some((c) => /Contrato cambiado/.test(c.body.body ?? '')));

    // ---- confirmar pero el commit sigue siendo apto (hallazgo leve): no bloquea
    reset();
    s = await scenario({ findingOver: { severity: 'low' }, runOver: { risk: 'low', score: 90 } });
    llmScript = [decision({ decision: 'confirmed', severity: 'low', explanation: 'Es real pero menor.', updated_quality_score: 88, updated_risk_level: 'low' })];
    await svc.process(job(s));
    fRow = await finding(s.findingId);
    check('confirmar un hallazgo leve con riesgo bajo: queda abierto pero NO bloquea y el commit queda APTO', fRow.status === 'open' && fRow.blocking === false && (await runRow(s.run.id)).gate_decision === 'apto');

    // ---- repreguntar (ronda 1 → 2)
    reset();
    s = await scenario();
    llmScript = [decision({ decision: 'need_more_info', explanation: 'No alcanzo a ver el cliente.', question: '¿En qué commit de acme/client quedó el cambio?', verify_with: { repo: 'acme/client', paths: ['src/client.ts'] } })];
    await svc.process(job(s));
    fRow = await finding(s.findingId);
    check('repreguntar: sigue pendiente, con la pregunta nueva y en la ronda 2', fRow.status === 'awaiting_clarification' && fRow.question === '¿En qué commit de acme/client quedó el cambio?' && fRow.clarification_round === 2 && fRow.needs_human === false, JSON.stringify(fRow));
    check('la repregunta se publica en GitHub mencionando al autor (una sola vez)', callsTo(/\/issues\/\d+\/comments$/, 'POST').filter((c) => c.body.body.includes('@ana-') && c.body.body.includes('¿En qué commit de acme/client quedó el cambio?')).length === 1 && fRow.question_posted_at !== null);
    check('el veredicto del commit no cambia mientras se repregunta', (await runRow(s.run.id)).gate_decision === 'requiere_revision');
    check('la conversación guarda explicación y nueva pregunta', /Pregunta: ¿En qué commit/.test((await thread(s.findingId)).at(-1).body));

    // ---- última ronda sin poder decidir → una persona
    reset();
    s = await scenario({ round: 2 });
    llmScript = [decision({ decision: 'need_more_info', explanation: 'Sigo sin poder comprobarlo.', question: 'Otra pregunta' })];
    await svc.process(job(s));
    fRow = await finding(s.findingId);
    check('en la última ronda "need_more_info" no repregunta: queda pendiente de una PERSONA', fRow.status === 'awaiting_clarification' && fRow.needs_human === true && fRow.clarification_round === 2 && fRow.question !== 'Otra pregunta', JSON.stringify(fRow));
    check('GitHub: avisa que un administrador debe decidir', callsTo(/\/issues\/\d+\/comments$/, 'POST').some((c) => /administrador debe confirmarlo o descartarlo/.test(c.body.body)));
    check('el cuerpo del issue lo marca como pendiente de decisión humana', callsTo(/\/issues\/\d+$/, 'PATCH').some((c) => /Pendiente de decisión de una persona/.test(c.body.body ?? '')));

    // ---- decisión manual del admin (sin LLM)
    reset();
    s = await scenario({ round: 2 });
    await q('UPDATE findings SET needs_human = true WHERE id = $1', [s.findingId]);
    const admin = (await q(`INSERT INTO users(email, name) VALUES ($1, 'Admin') RETURNING id`, [`adm-${suffix}@clar.test`]))[0].id;
    await svc.process(job(s, 'manual', { decision: 'dismiss', userId: admin, comment: 'Lo revisé a mano: está bien.' }));
    fRow = await finding(s.findingId);
    check('decisión manual "descartar": se aplica SIN consultar a la IA', llmRequests.length === 0 && fRow.status === 'dismissed_false_positive' && fRow.resolved_by === admin && fRow.needs_human === false, JSON.stringify(fRow));
    check('queda como mensaje del administrador en la conversación', (await thread(s.findingId)).at(-1).role === 'system' && /Lo revisé a mano/.test((await thread(s.findingId)).at(-1).body));
    check('y el veredicto del commit se recalcula', (await runRow(s.run.id)).gate_decision === 'apto');
    reset();
    s = await scenario({ round: 2, runOver: { risk: 'high', score: 50 } });
    await svc.process(job(s, 'manual', { decision: 'confirm', userId: admin }));
    fRow = await finding(s.findingId);
    check('decisión manual "confirmar": el hallazgo grave pasa a abierto y, con riesgo alto, bloquea (commit NO APTO)', llmRequests.length === 0 && fRow.status === 'open' && fRow.blocking === true && (await runRow(s.run.id)).gate_decision === 'no_apto', JSON.stringify([fRow.status, (await runRow(s.run.id)).gate_decision]));

    // ---- guardas
    reset();
    s = await scenario({ reply: null });
    await svc.process(job(s));
    check('si lo último en la conversación es la IA (no hay respuesta nueva) no se reevalúa', llmRequests.length === 0 && (await finding(s.findingId)).status === 'awaiting_clarification');
    reset();
    s = await scenario();
    await q(`UPDATE findings SET status = 'dismissed_false_positive' WHERE id = $1`, [s.findingId]);
    await svc.process(job(s));
    check('un hallazgo que ya no está pendiente se omite', llmRequests.length === 0 && gh.calls.length === 0);
    reset();
    s = await scenario();
    await svc.process(job(s, 'reply')).catch(() => undefined); // sin guion → todos los agentes fallan
    check('si el agente de IA falla el trabajo FALLA (se reintenta) y no se cambia nada', (await finding(s.findingId)).status === 'awaiting_clarification' && (await thread(s.findingId)).length === 2);
    reset();
    s = await scenario();
    llmScript = [() => ({ status: 400, body: { error: { message: 'tools not supported' } } }), decision({ decision: 'dismissed', explanation: 'Con lo que respondiste basta.' })];
    await svc.process(job(s));
    check('si el modelo no soporta herramientas, igual decide (sin verificar otros repos)', (await finding(s.findingId)).status === 'dismissed_false_positive' && llmRequests.length === 2 && llmRequests[1].tools === undefined);
    reset();
    s = await scenario();
    llmScript = [() => reply({ content: 'No sé responder en JSON' }), () => reply({ content: 'sigo sin JSON' }), () => reply({ content: 'tampoco' }), () => reply({ content: 'nada' })];
    const bad = await svc.process(job(s)).catch((e) => e);
    check('un modelo que no devuelve JSON válido no deja el hallazgo a medias (el trabajo falla y se reintenta)', bad instanceof Error && (await finding(s.findingId)).status === 'awaiting_clarification');

    // ================================================================== 5) herramientas remotas
    const toolbox = (extra = {}) =>
      new RemoteToolbox({
        git: { readRemoteFile: async (p) => (p.repo === 'client' ? { kind: 'file', path: p.path, content: 'ok', truncated: false } : null), searchRemoteCode: async () => [{ path: 'a.ts', url: 'u' }], getPullRequestContext: async () => [] },
        installationId: 1, owner: 'acme', repo: 'api', commitSha: 'a'.repeat(40), readable: ['acme/api', 'acme/client'], ...extra,
      });
    const T = toolbox();
    let r = await T.execute('read_remote_file', { repo: 'client', path: 'src/x.ts' });
    check('leer un repo permitido (aceptando solo el nombre, mismo owner)', r.ok && /acme\/client:src\/x\.ts/.test(r.output));
    r = await T.execute('read_remote_file', { repo: 'evil/otro', path: 'x' });
    check('leer un repo que NO está en la lista de legibles → rechazado y dice cuáles sí', !r.ok && /no puedo leer evil\/otro/.test(r.output) && /acme\/client/.test(r.output));
    r = await T.execute('read_remote_file', { repo: 'a/b/c', path: 'x' });
    check('repo con formato inválido → rechazado', !r.ok);
    r = await T.execute('read_remote_file', { path: '.env' });
    check('archivos secretos (.env) → rechazado también en repos remotos', !r.ok && /protegida/.test(r.output));
    r = await T.execute('search_remote_code', { query: 'foo repo:evil/otro' });
    check('búsqueda con calificadores (repo:, org:…) → rechazada: no se puede ampliar el alcance', !r.ok && /calificadores/.test(r.output));
    r = await T.execute('search_remote_code', { query: 'processPayment', repo: 'client' });
    check('búsqueda normal en un repo legible', r.ok && /a\.ts/.test(r.output));
    r = await T.execute('search_remote_code', { query: 'x'.repeat(200) });
    check('búsqueda demasiado larga → rechazada', !r.ok);
    r = await T.execute('write_file', {});
    check('no hay herramientas de escritura: solo lectura', !r.ok && T.definitions.map((d) => d.name).sort().join() === 'get_pull_request_context,read_remote_file,search_remote_code');
  } finally {
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@clar.test`]);
    await q('DELETE FROM llm_providers');
    for (const p of savedProviders) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at],
      );
    }
    await owner.end();
    ghServer.close();
    llmServer.close();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
