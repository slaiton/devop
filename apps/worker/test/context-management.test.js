/* Pruebas de la gestión de contexto por capa (que ningún modelo de Bedrock reciba más de lo que cabe en su ventana), contra el worker
 * COMPILADO dentro de su contenedor. Bedrock se simula con un servidor HTTP local que rechaza con 400 "Your input exceeds the context window"
 * lo que supere una ventana simulada:
 *   A) piezas puras: contador de tokens calibrado, comprobación previa, límite aprendido, compresión de herramientas, relevancia,
 *      fragmentación lógica, unión de resultados, reintento estrictamente decreciente, compresión para la capa 3,
 *   B) presupuesto por capa según la ventana configurada de cada agente,
 *   C) Layer2Service con un cambio grande: se divide en partes que caben, cada llamada respeta el presupuesto y los resultados se unen,
 *   D) rechazo real del proveedor: se reintenta con menos y el límite aprendido queda guardado.
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados; la clave de cifrado puede ser cualquiera de prueba):
 *   docker compose exec -T -e CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32) worker node - < apps/worker/test/context-management.test.js
 *
 * Crea una organización de prueba; guarda y restaura los agentes de IA y el presupuesto. */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
const { encrypt, getAuditBudget, setAuditBudget } = require('@devsentinel/settings');
const { clearLlmCooldowns, LlmContextOverflowError, tokenEstimator, assertFits, effectiveInputLimit, compressToolOutputs, inputTokenBudget } = require('@devsentinel/llm-port');

const DIST = '/repo/apps/worker/dist';
const { fitDiff, chunkDiff, relevanceScore } = require(`${DIST}/modules/review/inputBudget.js`);
const { inputBudgetFor, withContextRetry } = require(`${DIST}/common/contextBudget.js`);
const { mergeTriage } = require(`${DIST}/modules/audit/layer2/merge.js`);
const { buildLayer3Input, compressTriage, layer1Metrics } = require(`${DIST}/modules/audit/compress.js`);
const { Layer2Service } = require(`${DIST}/modules/audit/layer2/layer2.service.js`);
const { UsageSink } = require(`${DIST}/common/usageSink.js`);
const { createLayerRouter } = require(`${DIST}/common/llmRouter.factory.js`);

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const suffix = crypto.randomBytes(3).toString('hex');

// ------------------------------------------------------------------ Bedrock simulado con ventana limitada (en caracteres)
let script = [];
let requests = [];
let CONTEXT_CHARS = Infinity;
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
// prompt_tokens realista (≈ caracteres / 3.2) para que el estimador calibrado no se desvíe
const completion = (content, chars = 0) => ({
  status: 200,
  body: {
    id: 'c', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: Math.max(800, Math.round(chars / 3.2)), completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
  },
});
const triage = (over = {}) => ({
  resultado: 'APTO', quality_score: 90, risk_level: 'low', resumen_ejecutivo: 'Cambio acotado.', justificacion_final: 'Sin problemas.',
  comparacion_commits_previos: 'sin relación relevante', recomendaciones: ['Agregar pruebas'], tests_recomendados: ['test de login'],
  findings: [], groups: [], dismissed: [], escalation: { recommended: false, reasons: [] }, ...over,
});

const fileDiff = (rel, lines, prefix = 'export const v') =>
  [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`, `@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+${prefix}${i} = computeSomething(${i}, "argumento-${i}", { activo: true });`)].join('\n') + '\n';
const fileHunks = (rel, hunks, linesPerHunk) =>
  [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`]
    .concat(Array.from({ length: hunks }, (_, h) => [`@@ -${h * 1000 + 1},${linesPerHunk} +${h * 1000 + 1},${linesPerHunk} @@`].concat(Array.from({ length: linesPerHunk }, (_, i) => `+h${h}l${i} = computeSomething(${i}, "argumento-${i}", { activo: true });`)).join('\n')))
    .join('\n') + '\n';

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/v1`;
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const saved = await q('SELECT * FROM llm_providers');
  const savedBudget = await getAuditBudget(owner);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Ctx', $1) RETURNING id`, [`ctx-${suffix}`]))[0].id;
  const mkProvider = (name, model, position, layer = null, ctxWindow = null, maxOut = null) =>
    q(`INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position, enabled, audit_layer, context_window_tokens, max_output_tokens) VALUES ($1, 'bedrock', $2, $3, $4, $5, true, $6, $7, $8)`, [name, BASE, model, encrypt('k'), position, layer, ctxWindow, maxOut]);
  const reset = () => {
    script = [];
    requests = [];
    CONTEXT_CHARS = Infinity;
    clearLlmCooldowns();
    tokenEstimator.reset();
  };

  try {
    // ================================================================== A) piezas puras
    tokenEstimator.reset();
    check('contador de tokens: sin datos parte de una relación conservadora de 3 caracteres por token', tokenEstimator.charsPerToken('m1') === 3 && tokenEstimator.estimateChars('m1', 3000) === 1000);
    tokenEstimator.observe('m1', 30_000, 15_000); // el proveedor cobró 2 caracteres por token (peor que lo supuesto)
    const after = tokenEstimator.charsPerToken('m1');
    check('contador de tokens: aprende del consumo REAL (si cobra más tokens por carácter, estima más tokens) sin bajar de 1,8', after < 3 && after >= 1.8 && tokenEstimator.estimateChars('m1', 3000) > 1000);
    for (let i = 0; i < 40; i++) tokenEstimator.observe('m2', 100_000, 1_000);
    check('contador de tokens: aunque el texto sea muy compresible nunca confía en más de 3,5 caracteres por token', tokenEstimator.charsPerToken('m2') <= 3.5);

    const limits = { windowTokens: 20_000, reservedOutputTokens: 4_000 };
    check('presupuesto: ventana − reserva de salida, con margen de seguridad del 8 %', inputTokenBudget(limits) === Math.floor(16_000 * 0.92));
    const bigMsgs = [{ role: 'user', content: 'x'.repeat(200_000) }];
    let err = null;
    try { assertFits('m3', bigMsgs, limits); } catch (e) { err = e; }
    check('comprobación previa: una entrada que no cabe falla ANTES de enviarse con LlmContextOverflowError', err instanceof LlmContextOverflowError && /comprobación previa/.test(err.message));
    check('comprobación previa: lo que cabe pasa', assertFits('m3', [{ role: 'user', content: 'x'.repeat(10_000) }], limits) > 0);
    tokenEstimator.learnOverflow('m4', 50_000);
    check('límite aprendido: tras un rechazo real el techo queda por debajo de lo estimado y manda sobre la ventana configurada', tokenEstimator.learnedCeiling('m4') === 40_000 && effectiveInputLimit('m4', { windowTokens: 272_000, reservedOutputTokens: 16_000 }) === 40_000 && effectiveInputLimit('m5', undefined) === undefined);

    const conv = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'tarea' }, { role: 'tool', content: 'a'.repeat(30_000) }, { role: 'tool', content: 'b'.repeat(30_000) }, { role: 'tool', content: 'c'.repeat(1_000) }];
    const n = compressToolOutputs('m6', conv, { windowTokens: 20_000, reservedOutputTokens: 4_000 });
    check('compresión del bucle de herramientas: los resultados más antiguos y grandes se resumen (con aviso) hasta que quepa, sin tirar la conversación', n >= 1 && /resultado resumido/.test(conv[2].content) && conv[2].content.length < 1_000 && conv.length === 5 && conv[1].content === 'tarea');

    // ---- relevancia
    const hints = { priority: new Set(['src/auth/login.ts']), sensitive: new Set(['src/pay/charge.ts']) };
    check('relevancia: hallazgos graves > cambios sensibles > código > pruebas > documentación', relevanceScore('src/auth/login.ts', hints) > relevanceScore('src/pay/charge.ts', hints) && relevanceScore('src/pay/charge.ts', hints) > relevanceScore('src/util.ts', hints) && relevanceScore('src/util.ts', hints) > relevanceScore('test/util.test.ts', hints) && relevanceScore('test/util.test.ts', hints) > relevanceScore('docs/readme.md', hints));
    const mixed = fileDiff('docs/guide.md', 400) + fileDiff('test/a.test.ts', 400) + fileDiff('src/util.ts', 400) + fileDiff('src/auth/login.ts', 400);
    const one = fitDiff(mixed, 60_000, hints);
    check('relevancia: con presupuesto escaso entra primero el archivo con hallazgo grave y lo que se omite es documentación/pruebas, nombrado', one.diff.includes('src/auth/login.ts') && one.omittedFiles.length >= 1 && one.omittedFiles.every((f) => /docs|test/.test(f) || f === 'src/util.ts') && !one.omittedFiles.includes('src/auth/login.ts') && /NO aparecen arriba/.test(one.diff));

    // ---- fragmentación lógica
    const many = Array.from({ length: 10 }, (_, i) => fileDiff(`src/mod${i}.ts`, 250)).join('') + fileDiff('package-lock.json', 20_000);
    const ch = chunkDiff(many, 40_000, 8, undefined);
    const covered = new Set(ch.chunks.flatMap((c) => c.files));
    check('fragmentación: un cambio grande se parte en varias partes que caben, sin perder ningún archivo de código', ch.chunks.length >= 3 && ch.chunks.every((c) => c.diff.length <= 40_000 + 2_000) && covered.size === 10 && ch.omittedFiles.length === 0, `${ch.chunks.length} ${[...covered].length}`);
    check('fragmentación: los lockfiles se resumen en una línea en la primera parte (no viajan enteros)', ch.skippedLowValue.join() === 'package-lock.json' && /contenido omitido del análisis/.test(ch.chunks[0].diff) && !ch.chunks.some((c) => c.diff.length > 45_000));
    const capped = chunkDiff(many, 40_000, 2, undefined);
    check('fragmentación: con tope de partes lo que no entra se OMITE entero y se informa', capped.chunks.length === 2 && capped.omittedFiles.length > 0 && capped.omittedFiles.every((f) => /^src\/mod/.test(f)));
    const giant = fileHunks('src/giant.ts', 12, 400);
    const gch = chunkDiff(giant, 30_000, 8, undefined);
    check('fragmentación: un archivo gigante se parte por hunks, cada parte repite la cabecera del archivo y avisa "parte i de n"', gch.chunks.length >= 2 && gch.chunks.every((c) => c.diff.includes('diff --git a/src/giant.ts') && /\[parte \d+ de \d+ de este archivo\]/.test(c.diff)), `${gch.chunks.length}`);

    // ---- unión de resultados
    const merged = mergeTriage([
      triage({ resultado: 'APTO', quality_score: 95, risk_level: 'low', recomendaciones: ['A'], findings: [{ id: 'L2-1', title: 'x' }] }),
      triage({ resultado: 'NO_APTO', quality_score: 40, risk_level: 'high', recomendaciones: ['A', 'B'], findings: [{ id: 'L2-1', title: 'y' }], escalation: { recommended: true, reasons: ['auth'] }, groups: [{ title: 'G', finding_refs: ['F1'], rationale: 'r' }], dismissed: [{ ref: 'F2', reason: 'ruido' }] }),
      triage({ resultado: 'REQUIERE_REVISION', quality_score: 70, risk_level: 'medium', groups: [{ title: 'g', finding_refs: ['F3'], rationale: 'r' }] }),
    ]);
    check('unión: toma lo más estricto (peor veredicto, menor calidad, mayor riesgo, escalar si CUALQUIER parte lo pide); un fragmento tranquilo no tapa a otro', merged.resultado === 'NO_APTO' && merged.quality_score === 40 && merged.risk_level === 'high' && merged.escalation.recommended === true && merged.escalation.reasons.includes('auth'));
    check('unión: hallazgos con ids únicos por parte, recomendaciones sin repetir, grupos del mismo título unidos y descartes conservados', merged.findings.map((f) => f.id).join() === 'P1-L2-1,P2-L2-1' && ['A', 'B', 'Agregar pruebas'].every((r) => merged.recomendaciones.includes(r)) && merged.recomendaciones.length === 3 && merged.groups.length === 1 && merged.groups[0].finding_refs.join() === 'F1,F3' && merged.dismissed.length === 1 && /3 partes/.test(merged.resumen_ejecutivo));
    check('unión: una sola parte pasa igual', mergeTriage([triage()]).resultado === 'APTO');

    // ---- reintento inteligente
    const seen = [];
    const out = await withContextRetry(async (scale) => {
      seen.push(scale);
      if (scale > 0.25) throw new LlmContextOverflowError('no cabe');
      return 'ok';
    });
    check('reintento inteligente: 1 → 1/2 → 1/4, cada intento con un presupuesto ESTRICTAMENTE menor (nunca repite la misma solicitud)', out === 'ok' && seen.join() === '1,0.5,0.25' && seen.every((s, i) => i === 0 || s < seen[i - 1]));
    const seen2 = [];
    const exhausted = await withContextRetry(async (s) => { seen2.push(s); throw new LlmContextOverflowError('no cabe'); }).catch((e) => e);
    check('reintento inteligente: si ni con la cuarta parte cabe, falla con el error de tamaño', exhausted instanceof LlmContextOverflowError && seen2.length === 3);
    let calls = 0;
    const other = await withContextRetry(async () => { calls++; throw new Error('proveedor caído'); }).catch((e) => e);
    check('reintento inteligente: cualquier otro error se propaga de inmediato, sin reintentar', other.message === 'proveedor caído' && calls === 1);

    // ---- compresión para la capa 3
    const f = (o) => ({ tool: 'semgrep', ruleId: 'r', severity: 'high', category: 'sast', filePath: 'src/a.ts', lineStart: 3, lineEnd: 3, title: 't', message: 'inyección de comandos', validation: 'pending_validation', evidence: null, fingerprint: crypto.randomBytes(6).toString('hex'), baseline: 'new', sources: [{ tool: 'semgrep', ruleId: 'r' }], ...o });
    const l1 = { runs: [{ tool: 'semgrep', status: 'ok' }], findings: [f({}), f({ filePath: 'src/b.ts', severity: 'low' })], coverage: { complete: true, missing: [], technologies: ['ts'], suppressions: {}, scannerConfigFiles: [] } };
    const l2 = {
      status: 'ok', model: 'luna', changeTags: [{ tag: 'auth', files: ['src/auth/login.ts'] }], partial: false, escalation: { recommended: true, triggers: [{ type: 'sensitive_change', detail: 'Cambia autenticación' }] },
      reviewResult: { resultado: 'REQUIERE_REVISION', quality_score: 70, risk_level: 'medium', resumen_ejecutivo: 'Resumen del triaje.', justificacion_final: 'ok' },
      validated: { findings: [{ severity: 'high', validation_status: 'confirmed', file_path: 'src/c.ts', line_start: 9, title: 'Hallazgo del triaje', explanation: 'explicación' }], groups: [], dismissals: { accepted: [], ignored: [] } },
    };
    const original = {
      repositoryFullName: 'acme/api', commitSha: 'a'.repeat(40), staticFindings: [{ severity: 'low', filePath: 'x', message: 'm' }], retrievedContext: [{ filePath: 'rag', content: 'z'.repeat(5_000) }], projectProfile: {}, recentCommits: Array.from({ length: 9 }, () => ({ sha: 's', message: 'm', author: 'a', date: 'd' })),
      analyzedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/auth/login.ts', 'src/zzz.ts'],
      diff: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/auth/login.ts', 'src/zzz.ts'].map((p) => fileDiff(p, 300)).join(''),
    };
    const l3 = buildLayer3Input(original, l1, l2);
    check('capa 3: recibe el parche SOLO de los archivos con hallazgos graves, del triaje o de cambio sensible; el resto se nombra sin su código', ['src/a.ts', 'src/c.ts', 'src/auth/login.ts'].every((p) => l3.input.diff.includes(`diff --git a/${p} b/${p}`)) && !l3.input.diff.includes('diff --git a/src/b.ts') && !l3.input.diff.includes('diff --git a/src/zzz.ts') && /no se reenvía: ya lo auditó la capa 2/.test(l3.input.diff) && l3.input.diff.length < original.diff.length * 0.7);
    check('capa 3: en lugar del contexto previo recibe el resumen comprimido (veredicto, hallazgos, motivos de escalamiento) y pocos commits', l3.input.retrievedContext.length === 1 && /Triaje de la capa 2/.test(l3.input.retrievedContext[0].content) && /Hallazgo del triaje/.test(l3.input.retrievedContext[0].content) && /Cambia autenticación/.test(l3.input.retrievedContext[0].content) && l3.input.retrievedContext[0].content.length <= 7_100 && l3.input.recentCommits.length === 5);
    check('capa 1 → resto: solo métricas (conteos por severidad y herramienta), no la lista de hallazgos', /Hallazgos: 2 en total/.test(layer1Metrics(l1)) && !/inyección/.test(layer1Metrics(l1)));
    check('compresión: la capa 3 nunca supera el tope aunque el triaje sea enorme', compressTriage(l1, { ...l2, validated: { ...l2.validated, findings: Array.from({ length: 80 }, (_, i) => ({ severity: 'high', validation_status: 'confirmed', file_path: `src/f${i}.ts`, line_start: 1, title: 'T'.repeat(100), explanation: 'e'.repeat(2_000) })) } }, 7_000).length <= 7_100);

    // ================================================================== B) presupuesto por capa
    await q('DELETE FROM llm_providers');
    await mkProvider('Sol general', 'us.openai.gpt-5.6-sol', 1);
    await mkProvider('Luna capa 2', 'us.openai.gpt-5.6-luna', 2, 'layer2');
    reset();
    let b2 = await inputBudgetFor('layer2');
    let bg = await inputBudgetFor('general');
    check('presupuesto por capa: sin ventana configurada gana el tope de cada capa (capa 2: 100.000, general: 150.000) y la ventana por defecto (272K) deja pasar', b2.inputTokens === 100_000 && b2.reason === 'layer_cap' && bg.inputTokens === 150_000);
    check('presupuesto por capa: la capa 3 recibe un resumen, no el código: tope 60.000 aunque el agente aguante más', (await inputBudgetFor('general', { cap: 60_000 })).inputTokens === 60_000);
    await q(`UPDATE llm_providers SET context_window_tokens = 50000, max_output_tokens = 10000 WHERE audit_layer = 'layer2'`);
    b2 = await inputBudgetFor('layer2');
    check('presupuesto por capa: la ventana configurada del agente manda ((50.000 − 10.000 de respuesta) × 0,92 = 36.800) y se nombra el modelo que limita', b2.inputTokens === 36_800 && b2.reason === 'model_window' && b2.limitingModel === 'us.openai.gpt-5.6-luna');
    tokenEstimator.learnOverflow('us.openai.gpt-5.6-luna', 20_000);
    b2 = await inputBudgetFor('layer2');
    check('presupuesto por capa: un rechazo real del proveedor deja un límite aprendido menor (16.000) que gana a la ventana configurada', b2.inputTokens === 16_000 && b2.reason === 'learned_limit', JSON.stringify(b2));
    reset();

    // ================================================================== C) capa 2 con un cambio grande
    const root = `/tmp/ctx-${suffix}`;
    fs.mkdirSync(root, { recursive: true });
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 930000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 960000 + crypto.randomInt(1, 99999)]))[0].id;
    const mkRun = async () => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision, branch) VALUES ($1, $2, $3, 'push', 'running', 'apto', 'feature/x') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex')]))[0].id;
    await setAuditBudget(owner, { monthlyUsd: 500, perAuditUsd: 50, policy: 'partial' });
    await q(`UPDATE llm_providers SET context_window_tokens = 40000, max_output_tokens = 8000 WHERE audit_layer = 'layer2'`); // entrada ≤ 29.440 tokens ≈ 88.000 caracteres
    const fileCount = 8;
    const bigDiff = Array.from({ length: fileCount }, (_, i) => fileDiff(`src/mod${i}.ts`, 250)).join('');
    const l1big = { runs: [], findings: Array.from({ length: fileCount }, (_, i) => f({ ruleId: `r${i}`, filePath: `src/mod${i}.ts`, lineStart: 1, lineEnd: 1, sources: [{ tool: 'semgrep', ruleId: `r${i}` }] })), coverage: { complete: true, missing: [], technologies: ['ts'], suppressions: {}, scannerConfigFiles: [] } };
    const svc = new Layer2Service();
    const mk = async (over = {}) => {
      const runId = await mkRun();
      const sink = new UsageSink({ organizationId: org, reviewRunId: runId, repositoryId: repo });
      return { runId, sink, params: { payload: { organizationId: org, repositoryId: repo, reviewRunId: runId, owner: 'acme', repo: 'demo', commitSha: 'b'.repeat(40), branch: 'feature/x', pullNumber: null }, checkoutPath: root, diff: bigDiff, analyzedFiles: Array.from({ length: fileCount }, (_, i) => `src/mod${i}.ts`), layer1: l1big, projectProfile: { language: 'ts' }, recentCommits: [], sink, ...over } };
    };
    reset();
    const respond = (body) => completion(triage(), body.messages.reduce((a, m) => a + String(m.content).length, 0));
    script = [respond, (b) => completion(triage({ resultado: 'REQUIERE_REVISION', quality_score: 65, risk_level: 'medium' }), b.messages[1].content.length), (b) => completion(triage({ escalation: { recommended: true, reasons: ['toca autenticación'] } }), b.messages[1].content.length), respond, respond];
    let m = await mk();
    let res = await svc.run(m.params);
    const chars = requests.map((r) => r.chars);
    const maxChars = Math.floor(inputTokenBudget({ windowTokens: 40_000, reservedOutputTokens: 8_000 }) * 3);
    check('capa 2 grande: el cambio (≈ 650 KB) se divide en varias llamadas, TODAS dentro del presupuesto de la ventana del agente (nunca un 400)', res.status === 'ok' && requests.length >= 3 && chars.every((c) => c <= maxChars) && res.chunks.total === requests.length && res.chunks.analyzed === requests.length, JSON.stringify({ status: res.status, reason: res.reason, chars, maxChars }));
    const prompts = requests.map((r) => r.body.messages[1].content);
    const allFiles = new Set(prompts.flatMap((p) => [...p.matchAll(/diff --git a\/(src\/mod\d+\.ts)/g)].map((x) => x[1])));
    check('capa 2 grande: ningún archivo de código se pierde (cada uno viaja en alguna parte) y la revisión NO es parcial', allFiles.size === fileCount && res.partial === false);
    const refsByPrompt = prompts.map((p) => [...p.matchAll(/\b(F\d+): \[semgrep\/(r\d+)\]/g)].map((x) => `${x[1]}:${x[2]}`));
    const allRefs = refsByPrompt.flat();
    check('capa 2 grande: cada parte recibe solo los hallazgos de SUS archivos, con referencias GLOBALES (F1..F8) y sin repetirse entre partes', allRefs.length === fileCount && new Set(allRefs).size === fileCount && refsByPrompt.every((r) => r.length < fileCount), JSON.stringify(refsByPrompt));
    check('capa 2 grande: la unión es la más estricta (REQUIERE REVISIÓN, calidad 65, riesgo medio, escalar porque UNA parte lo pidió)', res.reviewResult.resultado === 'REQUIERE_REVISION' && res.reviewResult.quality_score === 65 && res.reviewResult.risk_level === 'medium' && res.escalation.recommended === true);
    check('capa 2 grande: el consumo de TODAS las partes queda registrado', res.usage.calls === requests.length && res.usage.promptTokens > 0);

    // más partes de las permitidas → revisión parcial, con el motivo, y nunca más llamadas que el tope
    reset();
    const huge = Array.from({ length: 30 }, (_, i) => fileDiff(`src/mod${i}.ts`, 250)).join('');
    script = Array.from({ length: 10 }, () => (b) => completion(triage(), b.messages[1].content.length));
    m = await mk({ diff: huge, analyzedFiles: Array.from({ length: 30 }, (_, i) => `src/mod${i}.ts`) });
    res = await svc.run(m.params);
    check('capa 2 enorme: más de 4 partes no se hacen (cada una cuesta): lo que no entra se informa y la revisión queda PARCIAL (nunca APTO)', res.status === 'ok' && requests.length === 4 && res.partial === true && /no entraron al triaje/.test(res.partialReason ?? ''), JSON.stringify([requests.length, res.partial, res.partialReason]));

    // presupuesto de dinero: las partes siguientes se detienen cuando ya no alcanza
    reset();
    script = Array.from({ length: 10 }, () => (b) => completion(triage(), b.messages[1].content.length));
    m = await mk();
    await q(`DELETE FROM llm_invocations WHERE review_run_id = $1`, [m.runId]);
    await setAuditBudget(owner, { monthlyUsd: 500, perAuditUsd: 0.02, policy: 'partial' }); // alcanza para ~1 parte
    res = await svc.run(m.params);
    check('presupuesto de dinero: si el límite por auditoría solo alcanza para algunas partes, se hacen esas, se detiene y queda PARCIAL con el motivo (no falla ni excede)', res.status === 'ok' && requests.length >= 1 && requests.length < 3 && res.partial === true && /Límite por auditoría/.test(res.partialReason ?? ''), JSON.stringify([res.status, requests.length, res.partialReason, res.reason]));
    await setAuditBudget(owner, { monthlyUsd: 500, perAuditUsd: 50, policy: 'partial' });

    // ================================================================== D) rechazo real del proveedor
    await q(`UPDATE llm_providers SET context_window_tokens = NULL, max_output_tokens = NULL WHERE audit_layer = 'layer2'`); // sin ventana configurada: el techo del despliegue permite mucho
    reset();
    CONTEXT_CHARS = 100_000; // el proveedor real rechaza más de esto, aunque la configuración diga que cabe
    script = Array.from({ length: 20 }, () => (b) => completion(triage(), b.messages[1].content.length));
    m = await mk({ diff: Array.from({ length: 10 }, (_, i) => fileDiff(`src/mod${i}.ts`, 250)).join(''), analyzedFiles: Array.from({ length: 10 }, (_, i) => `src/mod${i}.ts`) });
    res = await svc.run(m.params);
    const rejected = requests.filter((r) => r.chars > CONTEXT_CHARS);
    check('rechazo real: el proveedor rechaza por tamaño, la capa 2 reintenta con partes MÁS CHICAS (nunca la misma solicitud) y termina bien', res.status === 'ok' && rejected.length >= 1 && requests.at(-1).chars <= CONTEXT_CHARS && res.chunks.scale < 1, JSON.stringify({ status: res.status, reason: res.reason, chars: requests.map((r) => r.chars), scale: res.chunks.scale }));
    const sizesOfRejected = rejected.map((r) => r.chars);
    check('rechazo real: cada reintento es estrictamente menor que el rechazado antes', sizesOfRejected.every((s, i) => i === 0 || s < sizesOfRejected[i - 1]) && requests.filter((r) => r.chars <= CONTEXT_CHARS).every((r) => r.chars < Math.max(...sizesOfRejected)), JSON.stringify(sizesOfRejected));
    check('rechazo real: el límite queda aprendido para el siguiente análisis (no vuelve a intentar lo mismo)', tokenEstimator.learnedCeiling('us.openai.gpt-5.6-luna') !== undefined);
    check('rechazo real: NO se marca al agente como caído por un problema de tamaño', ((await q(`SELECT last_error FROM llm_providers WHERE audit_layer = 'layer2'`))[0].last_error ?? '') === '');

    // comprobación previa antes de la red
    reset();
    await q(`UPDATE llm_providers SET context_window_tokens = 20000, max_output_tokens = 4000 WHERE audit_layer = 'layer2'`);
    const lr = await createLayerRouter('layer2');
    const hugeInput = { repositoryFullName: 'acme/api', commitSha: 'a'.repeat(40), branch: 'x', baseBranch: null, pullNumber: null, changeTags: [], diff: 'x'.repeat(400_000), scannerFindings: [], coverageNote: 'ok', codeContext: [] };
    const pre = await lr.router.triageAudit(hugeInput).catch((e) => e);
    check('comprobación previa en el enrutador: una entrada que no cabe en la ventana del agente falla SIN hacer ninguna petición a Bedrock', pre instanceof LlmContextOverflowError && requests.length === 0, `${pre?.name} ${requests.length}`);
  } finally {
    await setAuditBudget(owner, savedBudget).catch(() => {});
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM llm_providers');
    for (const p of saved) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at, audit_layer, context_window_tokens, max_output_tokens)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at, p.audit_layer, p.context_window_tokens, p.max_output_tokens],
      );
    }
    await owner.end();
    server.close();
    fs.rmSync(`/tmp/ctx-${suffix}`, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
