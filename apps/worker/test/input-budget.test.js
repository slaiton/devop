/* Pruebas del presupuesto de entrada de los prompts y del error "Your input exceeds the context window of this model" de Bedrock,
 * contra el worker COMPILADO dentro de su contenedor:
 *   A) fitReviewInput / fitDiff: lockfiles y generados se resumen, los parches gigantes se recortan, lo que no cabe se omite y se dice,
 *   B) el error de contexto del proveedor se reconoce, NO es una falla del agente (sin pausa, sin marca de error) y no se confunde con "sin soporte de herramientas",
 *   C) flujo completo de ReviewService.runReview con un commit enorme y un modelo simulado que rechaza entradas grandes: se ajusta, se reintenta
 *      con menos, la revisión sale PARCIAL (nunca APTO) y el agente queda sin marcar como caído.
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados):
 *   docker compose exec -T worker node - < apps/worker/test/input-budget.test.js
 *
 * Crea una organización de prueba; guarda y restaura los agentes de IA. */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const { encrypt } = require('@devsentinel/settings');
const { clearLlmCooldowns, LlmContextOverflowError, AgenticReviewUnsupportedError, OpenAiCompatibleLlmAdapter, buildLlmRouter, isContextOverflow } = require('@devsentinel/llm-port');

const DIST = '/repo/apps/worker/dist';
const { fitReviewInput, fitDiff, isLowValueFile, partialReason, INPUT_LIMITS } = require(`${DIST}/modules/review/inputBudget.js`);
const { createLlmRouter } = require(`${DIST}/common/llmRouter.factory.js`);
const { ReviewService } = require(`${DIST}/modules/review/review.service.js`);

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const suffix = crypto.randomBytes(3).toString('hex');

const fileDiff = (rel, lines, prefix = 'export const v') =>
  [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`, `@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+${prefix}${i} = computeSomething(${i}, "argumento-${i}", { activo: true });`)].join('\n') + '\n';
const baseInput = (diff, over = {}) => ({
  repositoryFullName: 'acme/api', commitSha: 'a'.repeat(40), diff, staticFindings: [], retrievedContext: [], projectProfile: { language: 'ts' }, recentCommits: [],
  analyzedFiles: [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]), ...over,
});

// ------------------------------------------------------------------ modelo simulado con ventana de contexto limitada
let script = [];
let requests = [];
let CONTEXT_CHARS = 300_000;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const chars = (body.messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0);
    requests.push({ body, chars });
    let out;
    if (chars > CONTEXT_CHARS) out = { status: 400, body: { error: { message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' } } };
    else {
      const step = script.shift();
      out = step ? step(body) : { status: 500, body: { error: { message: 'sin guion' } } };
    }
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});
const completion = (content) => ({ status: 200, body: { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } } });
const REVIEW = { resultado: 'APTO', quality_score: 90, risk_level: 'low', resumen_ejecutivo: 'Todo bien.', findings: [], recomendaciones: [], tests_recomendados: [], comparacion_commits_previos: 'n/a', justificacion_final: 'ok' };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/v1`;

  // ================================================================== A) presupuesto de entrada
  check('archivos de bajo valor: lockfiles, minificados, generados, binarios y vendor', ['package-lock.json', 'web/yarn.lock', 'composer.lock', 'dist/app.js', 'public/app.min.js', 'node_modules/x/index.js', 'src/api.generated.ts', 'img/logo.png', 'a/b/go.sum', 'src/__snapshots__/a.snap'].every(isLowValueFile));
  check('el código normal NO es de bajo valor (ni un archivo que solo se llama "lock" en el nombre)', ['src/app.ts', 'src/lockdown.ts', 'src/auth/login.php', 'migrations/001.sql', 'docs/readme.md'].every((f) => !isLowValueFile(f)));

  const small = baseInput(fileDiff('src/a.ts', 20) + fileDiff('src/b.ts', 30));
  let r = fitReviewInput(small);
  check('un commit pequeño pasa EXACTAMENTE igual: el diff no se toca y no hay nada que avisar', r.input.diff === small.diff && r.report.notes.length === 0 && r.report.partial === false);

  const big = fileDiff('package-lock.json', 60_000) + fileDiff('src/a.ts', 40) + fileDiff('dist/bundle.js', 20_000) + fileDiff('src/b.ts', 40);
  r = fitReviewInput(baseInput(big));
  check('lockfiles y generados se resumen en una línea y el código real se conserva completo', r.report.skippedLowValue.join() === 'package-lock.json,dist/bundle.js' && /export const v39/.test(r.input.diff) && r.input.diff.length < 12_000 && /contenido omitido del análisis/.test(r.input.diff));
  check('resumir lo de bajo valor NO vuelve parcial la revisión (los escáneres ya cubren los lockfiles)', r.report.partial === false && partialReason(r.report) === null && r.report.notes.length === 1);

  const huge = Array.from({ length: 80 }, (_, i) => fileDiff(`src/mod${i}.ts`, 2500)).join('');
  const t0 = Date.now();
  r = fitReviewInput(baseInput(huge));
  check(`un diff de ${(huge.length / 1048576).toFixed(1)} MB se ajusta al presupuesto (≈${INPUT_LIMITS.maxInputTokens.toLocaleString('es')} tokens) en milisegundos`, r.report.estimatedTokens <= INPUT_LIMITS.maxInputTokens && Date.now() - t0 < 2000 && r.input.diff.length < huge.length / 3, `${r.report.estimatedTokens} tokens, ${Date.now() - t0} ms`);
  check('lo que no cabe se OMITE ENTERO (no se parte un archivo a la mitad sin avisar), con la lista de omitidos y marcado como parcial', r.report.omittedFiles.length > 0 && r.report.truncatedFiles.length > 0 && r.report.partial === true && /NO aparecen arriba/.test(r.input.diff) && r.input.diff.includes(r.report.omittedFiles[0]));
  check('los parches gigantes de un solo archivo se recortan con aviso y no acaparan el presupuesto', r.report.truncatedFiles.length > 0 && /parche recortado: 2505 líneas/.test(r.input.diff));
  check('la razón del análisis parcial se redacta para el usuario y dice que no puede aprobarse sola', /Revisión parcial/.test(partialReason(r.report)) && /no puede aprobarse automáticamente/.test(partialReason(r.report)));

  const r2 = fitReviewInput(baseInput(huge), 0.5);
  check('con la mitad del presupuesto (reintento) el prompt queda aún más pequeño', r2.input.diff.length < r.input.diff.length && r2.report.estimatedTokens < r.report.estimatedTokens && r2.report.omittedFiles.length > r.report.omittedFiles.length);

  const noisy = baseInput(fileDiff('src/a.ts', 10), {
    analyzedFiles: Array.from({ length: 5000 }, (_, i) => `src/f${i}.ts`),
    staticFindings: Array.from({ length: 500 }, (_, i) => ({ tool: 'semgrep', ruleId: `r${i}`, filePath: 'a.ts', line: 1, message: 'm', severity: i === 499 ? 'critical' : 'low' })),
    retrievedContext: Array.from({ length: 40 }, (_, i) => ({ filePath: `c${i}.ts`, content: 'x'.repeat(5000) })),
    recentCommits: Array.from({ length: 50 }, (_, i) => ({ sha: `${i}`.padStart(40, '0'), message: 'm'.repeat(2000), author: 'a', date: 'd' })),
  });
  r = fitReviewInput(noisy);
  check('también se acotan la lista de archivos (5.000), los hallazgos de analizadores (500), el contexto recuperado y el historial', r.input.analyzedFiles.length <= INPUT_LIMITS.maxListedFiles + 1 && /y 4700 archivos más/.test(r.input.analyzedFiles.at(-1)) && r.input.staticFindings.length === INPUT_LIMITS.maxStaticFindings && r.input.staticFindings[0].severity === 'critical' && r.input.retrievedContext.reduce((n, c) => n + c.content.length, 0) <= INPUT_LIMITS.maxContextChars && r.input.recentCommits.length === INPUT_LIMITS.maxRecentCommits && r.input.recentCommits[0].message.length === 300);
  check('la entrada original no se modifica (se puede reintentar desde ella)', noisy.analyzedFiles.length === 5000 && noisy.staticFindings.length === 500);

  const bin = baseInput(`diff --git a/img/a.png b/img/a.png\nBinary files /dev/null and b/img/a.png differ\n` + fileDiff('src/a.ts', 5));
  r = fitReviewInput(bin);
  check('un archivo binario se resume y no cuenta como código omitido', /archivo binario/.test(r.input.diff) && r.report.partial === false);

  // ================================================================== B) error de contexto del proveedor
  check('isContextOverflow reconoce el mensaje de Bedrock y variantes (400/413), y NO confunde otros errores', isContextOverflow({ status: 400, message: '400 Your input exceeds the context window of this model. Please adjust your input and try again.' }) && isContextOverflow({ status: 400, message: "This model's maximum context length is 128000 tokens" }) && isContextOverflow({ status: 413, message: 'Request too large' }) && !isContextOverflow({ status: 429, message: 'Throttling: too many requests' }) && !isContextOverflow({ status: 400, message: 'Unsupported value: temperature' }) && !isContextOverflow({ status: 500, message: 'context window' }));

  const mkAdapter = () => new OpenAiCompatibleLlmAdapter('us.openai.gpt-5.6-sol', BASE, 'k', async () => [], { temperature: null });
  CONTEXT_CHARS = 1000;
  requests = []; script = [];
  const reviewInput = baseInput(fileDiff('src/a.ts', 200));
  let err = await mkAdapter().reviewDiff(reviewInput).catch((e) => e);
  check('el adaptador convierte el 400 de contexto en LlmContextOverflowError (sin reintentos inútiles)', err instanceof LlmContextOverflowError && requests.length >= 1 && /exceeds the context window/.test(err.message), String(err));
  requests = [];
  err = await mkAdapter().reviewDiffAgentic(reviewInput, { definitions: [{ name: 'list_dir', description: 'x', parameters: { type: 'object', properties: {} } }], execute: async () => ({ ok: true, output: '', summary: '' }) }, { maxRounds: 3, maxToolCalls: 5, maxToolChars: 1000, deadlineMs: 30_000 }).catch((e) => e);
  check('en el modo profundo, "no cabe" NO se confunde con "el modelo no soporta herramientas"', err instanceof LlmContextOverflowError && !(err instanceof AgenticReviewUnsupportedError), err?.name);

  // el enrutador: no pausa al agente, no lo marca como caído y, si ninguno puede, avisa que es un problema de tamaño
  const attempts = [];
  const cooldowns = new Map();
  const cfg = (id, name) => ({ id, name, kind: 'bedrock', baseUrl: BASE, model: 'us.openai.gpt-5.6-sol', apiKey: 'k' });
  const router = buildLlmRouter([cfg('a', 'Sol A'), cfg('b', 'Sol B')], { mode: 'failover', cooldowns, onAttempt: (rec) => attempts.push(rec) });
  err = await router.reviewDiff(reviewInput).catch((e) => e);
  check('si NINGÚN agente puede con el tamaño → LlmContextOverflowError (no "fallaron todos los agentes")', err instanceof LlmContextOverflowError && /ningún agente/.test(err.message), String(err));
  check('el desborde de contexto NO pausa a los agentes (la entrada es el problema, no ellos)', cooldowns.size === 0 && router.order().length === 2);
  check('cada intento queda marcado inputTooLarge para que no se anote como error del agente', attempts.length >= 2 && attempts.every((a) => a.inputTooLarge === true && a.ok === false));

  CONTEXT_CHARS = 300_000;

  // ================================================================== C) flujo completo con un commit enorme
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const saved = await q('SELECT * FROM llm_providers');
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Budget', $1) RETURNING id`, [`bud-${suffix}`]))[0].id;
  const root = `/tmp/bud-${suffix}`;
  fs.mkdirSync(root, { recursive: true });
  try {
    await q('DELETE FROM llm_providers');
    await q(`INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position) VALUES ('Sol', 'bedrock', $1, 'us.openai.gpt-5.6-sol', $2, 1)`, [BASE, encrypt('k')]);
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 940000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 990000 + crypto.randomInt(1, 99999)]))[0].id;
    const mkRun = async () => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision, branch) VALUES ($1, $2, $3, 'push', 'running', 'apto', 'feature/x') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex')]))[0].id;
    const calls = { checks: [], summaries: [] };
    let currentDiff = '';
    const fakeGit = {
      getCommitDiff: async () => currentDiff, getPullRequestDiff: async () => currentDiff, getInstallationToken: async () => 'tok', getRecentCommits: async () => [],
      setCheckRunStatus: async (p) => calls.checks.push(p), postSummaryComment: async (p) => calls.summaries.push(p), postReviewComment: async () => {},
    };
    const rag = { indexAndRetrieve: async () => [], indexRepositorySample: async () => 0, search: async () => [] };
    const mkSvc = () => {
      const s = new ReviewService({ withCheckout: async (_p, fn) => fn(root) }, { run: async () => [] }, rag, { run: async () => { throw new Error('capa 1 no esperada'); } }, { run: async () => { throw new Error('capa 2 no esperada'); } });
      s.buildClients = async (_o, _i, usage) => ({ gitAdapter: fakeGit, llm: await createLlmRouter(usage) });
      s.getProjectProfile = async () => ({ language: 'ts', framework: 'x', conventions: [], mandatory_rules: [] });
      s.maybeAutoCreatePullRequest = async () => {};
      s.notifyAuthorOnPush = async () => {};
      s.syncFindingsIssue = async () => {};
      return s;
    };
    const job = async () => ({ organizationId: org, repositoryId: repo, installationId: 1, owner: 'acme', repo: 'demo', commitSha: 'c'.repeat(40), reviewRunId: await mkRun(), branch: 'feature/x', pullNumber: 5 });
    const runRow = (id) => q('SELECT * FROM review_runs WHERE id = $1', [id]).then((x) => x[0]);

    // (a) commit enorme: el primer intento (≈450K caracteres) lo rechaza el modelo (ventana simulada de 300K); el reintento con la mitad pasa
    clearLlmCooldowns();
    requests = [];
    CONTEXT_CHARS = 300_000;
    script = [() => completion(REVIEW)];
    currentDiff = Array.from({ length: 60 }, (_, i) => fileDiff(`src/mod${i}.ts`, 2500)).join('');
    let j = await job();
    await mkSvc().runReview(j);
    let row = await runRow(j.reviewRunId);
    const sizes = requests.map((x) => x.chars);
    check('flujo (a): primero se envía lo que cabe en el presupuesto, el modelo lo rechaza por tamaño y se reintenta con menos (cada intento más chico)', requests.length >= 2 && sizes[0] > CONTEXT_CHARS && sizes.at(-1) <= CONTEXT_CHARS && sizes.every((n, i) => i === 0 || n < sizes[i - 1]), JSON.stringify(sizes));
    check('flujo (a): la revisión se COMPLETA (no se cae con un 400)', row.status === 'completed' && row.quality_score === 90);
    check('flujo (a): por ser parcial, el modelo dijo APTO pero queda REQUIERE REVISIÓN, y la nota explica el ajuste por tamaño', row.gate_decision === 'requiere_revision' && row.llm_verdict === 'apto' && /Ajuste por tamaño/.test(row.analysis_note) && /no entraron al análisis/.test(row.analysis_note), `${row.gate_decision} | ${row.analysis_note}`);
    check('flujo (a): el check de GitHub sale "neutral" y dice que fue una revisión parcial', calls.checks.at(-1).conclusion === 'neutral' && /Revisión parcial/.test(calls.checks.at(-1).summary) && /Revisión parcial/.test(calls.summaries.at(-1).body));
    const prov = (await q(`SELECT last_error, last_used_at FROM llm_providers WHERE name = 'Sol'`))[0];
    check('flujo (a): el agente NO queda marcado como caído por un problema de tamaño (solo se anota su uso correcto)', (prov.last_error ?? '') === '' && prov.last_used_at !== null, JSON.stringify(prov));

    // (b) commit enorme pero casi todo es lockfile/generado: cabe, no es parcial y sigue pudiendo ser APTO
    requests = [];
    script = [() => completion(REVIEW)];
    currentDiff = fileDiff('package-lock.json', 90_000) + fileDiff('dist/main.js', 50_000) + fileDiff('src/a.ts', 30);
    calls.checks.length = 0;
    j = await job();
    await mkSvc().runReview(j);
    row = await runRow(j.reviewRunId);
    check('flujo (b): un commit de ~9 MB que es casi todo lockfile y generado se resume, entra en UNA sola llamada pequeña y puede ser APTO (no es parcial)', requests.length === 1 && requests[0].chars < 60_000 && row.gate_decision === 'apto' && /bajo valor/.test(row.analysis_note) && !/Revisión parcial/.test(calls.checks.at(-1).summary), `${requests.length} ${requests[0]?.chars} ${row.gate_decision}`);

    // (c) un commit normal no cambia en nada
    requests = [];
    script = [() => completion(REVIEW)];
    currentDiff = fileDiff('src/a.ts', 50);
    j = await job();
    await mkSvc().runReview(j);
    row = await runRow(j.reviewRunId);
    check('flujo (c): un commit normal sigue igual: una llamada, APTO, sin notas de ajuste', requests.length === 1 && row.gate_decision === 'apto' && !row.analysis_note);
    check('flujo (c): el diff llega íntegro al modelo', requests[0].body.messages[1].content.includes(currentDiff.trimEnd()));

    // (d) ni con el cuarto del presupuesto cabe (ventana minúscula): falla con el motivo de tamaño, sin marcar al agente como caído
    requests = [];
    CONTEXT_CHARS = 5_000;
    script = [];
    currentDiff = Array.from({ length: 20 }, (_, i) => fileDiff(`src/mod${i}.ts`, 2500)).join('');
    j = await job();
    const failed = await mkSvc().runReview(j).catch((e) => e);
    row = await runRow(j.reviewRunId);
    check('flujo (d): si ni reduciendo cabe, la revisión falla CON el motivo de tamaño (se ve en la página), tras 3 intentos decrecientes', failed instanceof LlmContextOverflowError && row.status === 'failed' && /ventana de contexto/.test(row.error_message) && requests.length === 3, `${failed?.name} ${requests.length}`);
    check('flujo (d): tampoco así se marca al agente como caído', ((await q(`SELECT last_error FROM llm_providers WHERE name = 'Sol'`))[0].last_error ?? '') === '');
  } finally {
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM llm_providers');
    for (const p of saved) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at, audit_layer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at, p.audit_layer],
      );
    }
    await owner.end();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
