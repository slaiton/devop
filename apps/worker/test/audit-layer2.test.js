/* Pruebas de la auditoría por capas — capa 2 (triaje con un modelo barato), la asignación de modelo por capa, los costos y el
 * presupuesto, contra el worker COMPILADO dentro de su contenedor. Bedrock se simula con un servidor HTTP local (la suite no
 * depende de llamadas reales):
 *   A) piezas puras: tipo de cambio, validación de la respuesta contra el repositorio, escalamiento, tarifas y costo,
 *   B) enrutador: agentes por capa vs generales, forma exacta de la petición (json_schema estricto, razonamiento, sin temperature),
 *   C) Layer2Service con base de datos real: contexto sin secretos, presupuesto, fallos del modelo,
 *   D) flujo completo de ReviewService.runReview con las capas 1 y 2 activas (capa 1 simulada: sus pruebas viven en audit-layer1).
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados):
 *   docker compose exec -T worker node - < apps/worker/test/audit-layer2.test.js
 *
 * Crea una organización de prueba; guarda y restaura los agentes de IA y el presupuesto. */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const { withTenant } = require('@devsentinel/database');
const { encrypt, getAuditBudget, setAuditBudget, parseBedrockModel, findPrice, computeCostUsd, getMonthSpendUsd } = require('@devsentinel/settings');
const { clearLlmCooldowns, TRIAGE_JSON_SCHEMA, triageResultSchema } = require('@devsentinel/llm-port');

const DIST = '/repo/apps/worker/dist';
const { classifyChange } = require(`${DIST}/modules/audit/layer2/changeProfile.js`);
const { validateTriage } = require(`${DIST}/modules/audit/layer2/validate.js`);
const { evaluateEscalation } = require(`${DIST}/modules/audit/layer2/escalation.js`);
const { Layer2Service } = require(`${DIST}/modules/audit/layer2/layer2.service.js`);
const { UsageSink } = require(`${DIST}/common/usageSink.js`);
const { createLlmRouter, createLayerRouter } = require(`${DIST}/common/llmRouter.factory.js`);
const { ReviewService } = require(`${DIST}/modules/review/review.service.js`);
const { guardsFromLayer1, applyAuditGuards } = require(`${DIST}/modules/audit/policy.js`);
const { recomputeGateDecision } = require(`${DIST}/common/gate.js`);

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const suffix = crypto.randomBytes(3).toString('hex');
// Credencial INVENTADA con formato real, armada en tiempo de ejecución (el escaneo de secretos de GitHub bloquearía el literal).
const FAKE_PAT = ['ghp', '_R4nd0mT0kenValu3Ab9Xy7Qw2Er5Ty8Ui0Op'].join('');

// ------------------------------------------------------------------ Bedrock simulado
let script = [];
let requests = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push({ body, auth: req.headers.authorization });
    const step = script.shift();
    const { status, body: out } = step ? step(body) : { status: 500, body: { error: { message: 'sin guion' } } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
const completion = (content, usage = {}) => ({
  status: 200,
  body: {
    id: 'c', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10_000, completion_tokens: 2_000, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 500 }, ...usage },
  },
});
const triage = (over = {}) => ({
  resultado: 'APTO', quality_score: 90, risk_level: 'low', resumen_ejecutivo: 'Cambio acotado y sin riesgos relevantes.', justificacion_final: 'Los hallazgos son ruido.',
  comparacion_commits_previos: 'sin relación relevante', recomendaciones: ['Agregar pruebas'], tests_recomendados: ['test de login'],
  findings: [], groups: [], dismissed: [], escalation: { recommended: false, reasons: [] }, ...over,
});
const ownFinding = (over = {}) => ({
  id: 'L2-1', category: 'security', severity: 'medium', confidence: 0.8, file_path: 'src/vuln.py', line_start: 4, line_end: 4, title: 'Inyección de comandos',
  evidence: 'os.system("ls " + u)', scenario: 'Un usuario controla u y ejecuta comandos.', impact: 'Ejecución remota de código.', recommendation: 'Usar subprocess con lista.',
  validation_status: 'confirmed', source_refs: [], needs_layer3: false, escalation_reason: null, suggested_tests: ['test de inyección'], ...over,
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/v1`;
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const pool = owner;
  const savedProviders = await q('SELECT * FROM llm_providers');
  const savedBudget = await getAuditBudget(pool);

  // ================================================================== A) piezas puras
  const tags = classifyChange(['src/auth/login.controller.ts', '.github/workflows/ci.yml', 'db/migrations/0042_add_col.sql', 'terraform/iam_roles.tf', 'src/billing/invoice.service.ts', 'package-lock.json', 'src/util/strings.ts']);
  const tagNames = tags.map((t) => t.tag).sort().join();
  check('tipo de cambio por rutas: auth, ci_cd, migration, iam, infra, payments y dependencias; un archivo común no etiqueta nada', tagNames === 'auth,ci_cd,dependencies,iam,infra,migration,payments' && !tags.some((t) => t.files.includes('src/util/strings.ts')), tagNames);

  const priceLunaUs = await findPrice(pool, 'us.openai.gpt-5.6-luna', 10_000);
  check('tarifa vigente de Luna (geo us, contexto corto) tomada de la base: 0,22 entrada / 1,32 salida', priceLunaUs && priceLunaUs.inputPerMtok === 0.22 && priceLunaUs.outputPerMtok === 1.32 && priceLunaUs.contextTier === 'short', JSON.stringify(priceLunaUs));
  check('costo: 10.000 entrada + 2.000 salida con Luna = 0,00484 USD', Math.abs(computeCostUsd(priceLunaUs, { promptTokens: 10_000, completionTokens: 2_000 }) - 0.00484) < 1e-9);
  check('costo con caché: lectura a 0,022 y escritura a 0,275 por millón (la caché es parte de la entrada)', Math.abs(computeCostUsd(priceLunaUs, { promptTokens: 10_000, completionTokens: 0, cachedTokens: 4_000, cacheWriteTokens: 1_000 }) - (5_000 * 0.22 + 1_000 * 0.275 + 4_000 * 0.022) / 1e6) < 1e-9);
  const priceLong = await findPrice(pool, 'us.openai.gpt-5.6-sol', 300_000);
  check('más de 272K tokens de entrada → tarifa de contexto largo (Sol us: 8,80 / 33,00)', priceLong.contextTier === 'long' && priceLong.inputPerMtok === 8.8 && priceLong.outputPerMtok === 33);
  check('el perfil global tiene su propia tarifa (Sol global corto: 4,00 / 20,00) y el id sin prefijo es in-region', (await findPrice(pool, 'global.openai.gpt-5.6-sol', 1000)).inputPerMtok === 4 && parseBedrockModel('openai.gpt-5.6-sol').inference === 'in_region' && parseBedrockModel('us.openai.gpt-5.6-luna').key === 'gpt-5.6-luna');
  check('un modelo sin tarifa (otro proveedor) devuelve null: no se inventa un precio', (await findPrice(pool, 'deepseek-chat', 1000)) === null && parseBedrockModel('deepseek-chat') === null);

  // ---- validación de la respuesta contra el repositorio
  const root = `/tmp/l2-${suffix}`;
  const w = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  w('src/vuln.py', 'import os\ndef run(u):\n    # ejecuta el comando\n    os.system("ls " + u)\n    return 1\n');
  w('src/config.js', `const token = "${FAKE_PAT}";\nmodule.exports = { token };\n`);
  w('src/auth/login.js', 'function login(user, pass) {\n  return user === "admin";\n}\n');
  w('package-lock.json', '{}');
  const nf = (over) => ({ tool: 'semgrep', ruleId: 'r', severity: 'high', category: 'sast', filePath: 'src/vuln.py', lineStart: 4, lineEnd: 4, title: 't', message: 'm', validation: 'pending_validation', evidence: null, fingerprint: crypto.randomBytes(8).toString('hex'), baseline: 'new', sources: [{ tool: 'semgrep', ruleId: 'r' }], ...over });
  const F_SECRET = nf({ tool: 'gitleaks', ruleId: 'github-pat', category: 'secret', severity: 'critical', filePath: 'src/config.js', lineStart: 1, lineEnd: 1, validation: 'confirmed', sources: [{ tool: 'gitleaks', ruleId: 'github-pat' }] });
  const F_SAST = nf({ ruleId: 'os-system', sources: [{ tool: 'semgrep', ruleId: 'os-system' }] });
  const F_DEP = nf({ tool: 'trivy', ruleId: 'CVE-2020-8203', category: 'dependency', severity: 'high', filePath: 'package-lock.json', lineStart: undefined, validation: 'confirmed', baseline: 'preexisting', packageName: 'lodash', sources: [{ tool: 'trivy', ruleId: 'CVE-2020-8203' }] });
  const refMap = new Map([['F1', F_SECRET], ['F2', F_SAST], ['F3', F_DEP]]);
  const vctx = { checkoutPath: root, diffText: '+    os.system("ls " + u)\n+function nuevaFuncion() { return 42; }', refMap, orderedRefs: ['F1', 'F2', 'F3'] };

  let v = await validateTriage(
    triage({
      findings: [
        ownFinding(), // válido
        ownFinding({ id: 'L2-2', file_path: 'src/no-existe.py', title: 'Archivo inventado' }),
        ownFinding({ id: 'L2-3', line_start: 999, title: 'Línea inexistente' }),
        ownFinding({ id: 'L2-4', evidence: 'esto no está en ningún lado del código', title: 'Evidencia inventada' }),
        ownFinding({ id: 'L2-5', evidence: 'corta', title: 'Sin evidencia' }),
        ownFinding({ id: 'L2-6', file_path: '../../etc/passwd', title: 'Salida del repo' }),
        ownFinding({ id: 'L2-7', file_path: 'src/auth/login.js', line_start: 2, line_end: 2, evidence: 'function nuevaFuncion() { return 42; }', title: 'Evidencia en el diff', validation_status: 'pending_validation', severity: 'critical', source_refs: ['F2', 'F99'] }),
        ownFinding({ id: 'L2-8', validation_status: 'false_positive_suspected', title: 'Probable ruido' }),
      ],
      dismissed: [
        { ref: 'F1', reason: 'Es un token de ejemplo sin valor real en este repositorio.' }, // secreto → nunca
        { ref: 'F3', reason: 'La función vulnerable de lodash no se usa en este proyecto.' }, // determinista confirmado → se mantiene
        { ref: 'F2', reason: 'corto' }, // sin motivo suficiente
        { ref: 'F99', reason: 'No existe esa referencia en la lista.' },
      ],
      groups: [{ title: 'Ejecución de comandos', finding_refs: ['F2', 'F77'], rationale: 'Misma causa.' }, { title: 'Grupo fantasma', finding_refs: ['F88'], rationale: 'x' }],
    }),
    vctx,
  );
  const acceptedTitles = v.findings.map((f) => f.title);
  check('validación: se acepta el hallazgo con archivo, línea y evidencia reales', acceptedTitles.includes('Inyección de comandos'));
  check('validación: se rechazan archivo inexistente, línea inexistente, evidencia inventada, evidencia ausente y rutas fuera del repo', ['Archivo inventado', 'Línea inexistente', 'Evidencia inventada', 'Sin evidencia', 'Salida del repo'].every((t) => v.rejected.some((r) => r.title === t)) && !acceptedTitles.some((t) => /inventad|inexistente|Sin evidencia|Salida/.test(t)), JSON.stringify(v.rejected.map((r) => r.title)));
  const fromDiff = v.findings.find((f) => f.title === 'Evidencia en el diff');
  check('validación: la evidencia puede salir del diff (no solo del archivo)', !!fromDiff);
  check('validación: un hallazgo sin comprobar (pending) no puede ser grave: "critical" baja a "medium"; las referencias inválidas se quitan', fromDiff.severity === 'medium' && fromDiff.validation_status === 'pending_validation' && fromDiff.source_refs.length === 1 && fromDiff.source_refs[0] === F_SAST.fingerprint, JSON.stringify(fromDiff));
  check('validación: lo que el modelo mismo cree ruido no es un hallazgo (queda como nota)', !acceptedTitles.includes('Probable ruido') && v.suspected.length === 1);
  const ign = Object.fromEntries(v.dismissals.ignored.map((d) => [d.ref, d.why]));
  check('descartes: un SECRETO nunca se descarta por la opinión de un modelo', /secreto nunca se descarta/.test(ign.F1) && !v.dismissals.accepted.some((d) => d.ref === 'F1'));
  check('descartes: una coincidencia determinista confirmada (Trivy) se mantiene y queda como conflicto', /determinista confirmada/.test(ign.F3) && v.conflicts.length === 2);
  check('descartes: sin motivo suficiente o con referencia inexistente se ignoran', /motivo suficiente/.test(ign.F2) && /no existe/.test(ign.F99) && v.dismissals.accepted.length === 0);
  check('grupos: se quitan las referencias inexistentes y los grupos que se quedan vacíos', v.groups.length === 1 && v.groups[0].refs.join() === 'F2');

  v = await validateTriage(triage({ dismissed: [{ ref: 'F2', reason: 'El comando solo recibe valores fijos de una lista blanca interna.' }] }), vctx);
  check('descartes: un hallazgo heurístico (Semgrep) sí se acepta como posible falso positivo, con su motivo y anotación', v.dismissals.accepted.length === 1 && v.annotations.find((a) => a.ref === 'F2').dismissed === true && v.annotations.find((a) => a.ref === 'F1').dismissed === false && v.annotations[0].priority === 1);

  // ---- escalamiento
  const ecfg = { sensitiveTags: ['auth', 'iam', 'ci_cd', 'migration', 'payments'] };
  const empty = await validateTriage(triage(), vctx);
  const esc = (over) => evaluateEscalation({ triage: triage(), validated: empty, changeTags: [], layer1Findings: [], config: ecfg, ...over });
  check('escalamiento: un cambio común sin hallazgos graves no escala', esc({}).recommended === false);
  check('escalamiento: cambio de autenticación / CI-CD / migración escala siempre (regla de la aplicación, no del modelo)', esc({ changeTags: [{ tag: 'auth', files: ['src/auth/login.js'] }] }).triggers[0].type === 'sensitive_change' && esc({ changeTags: [{ tag: 'dependencies', files: ['package.json'] }] }).recommended === false);
  check('escalamiento: la recomendación del modelo, un hallazgo grave confirmado nuevo, el riesgo alto o un conflicto con un escáner también escalan', esc({ triage: triage({ escalation: { recommended: true, reasons: ['posible fallo de autorización'] } }) }).triggers[0].type === 'model_recommendation' && esc({ layer1Findings: [nf({ severity: 'critical', validation: 'confirmed', category: 'iac' })] }).triggers[0].type === 'serious_finding' && esc({ triage: triage({ risk_level: 'high' }) }).triggers[0].type === 'high_risk' && esc({ validated: { ...empty, conflicts: ['F3: x'] } }).triggers[0].type === 'conflict');
  check('escalamiento: un hallazgo grave PREEXISTENTE no escala (no lo introdujo este cambio)', esc({ layer1Findings: [nf({ severity: 'critical', validation: 'confirmed', category: 'iac', baseline: 'preexisting' })] }).recommended === false);
  check('el esquema JSON estricto exige todos los campos y prohíbe propiedades extra (requisito de la salida estructurada de Bedrock)', (() => {
    const walk = (s) => {
      if (!s || typeof s !== 'object') return true;
      if (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) {
        if (s.additionalProperties !== false) return false;
        const props = Object.keys(s.properties ?? {});
        if (props.length !== (s.required ?? []).length || !props.every((p) => s.required.includes(p))) return false;
        if (!props.every((p) => walk(s.properties[p]))) return false;
      }
      if (s.items && !walk(s.items)) return false;
      return true;
    };
    return walk(TRIAGE_JSON_SCHEMA) && triageResultSchema.safeParse(triage({ findings: [ownFinding()] })).success;
  })());

  // ================================================================== B) enrutador por capa
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Audit L2', $1) RETURNING id`, [`l2-${suffix}`]))[0].id;
  const mkProvider = (name, model, position, layer = null, enabled = true) =>
    q(`INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position, enabled, audit_layer) VALUES ($1, 'bedrock', $2, $3, $4, $5, $6, $7)`, [name, BASE, model, encrypt('bedrock-key'), position, enabled, layer]);
  const reset = () => {
    script = [];
    requests = [];
    clearLlmCooldowns();
  };
  try {
    await q('DELETE FROM llm_providers');
    await mkProvider('Sol general', 'us.openai.gpt-5.6-sol', 1);
    await mkProvider('Luna capa 2', 'us.openai.gpt-5.6-luna', 2, 'layer2');
    reset();
    script = [() => completion(triage())];
    const general = await createLlmRouter();
    check('el enrutador general solo usa los agentes generales (Luna, asignado a la capa 2, queda fuera de la rotación)', general.order().length === 1 && general.order()[0].name === 'Sol general');
    const layerRouter = await createLayerRouter('layer2');
    check('el enrutador de la capa 2 usa solo el agente asignado a ella', layerRouter.models.join() === 'us.openai.gpt-5.6-luna' && (await createLayerRouter('layer3')) === null);
    await q(`UPDATE llm_providers SET enabled = false WHERE audit_layer = 'layer2'`);
    check('sin agente activo en la capa → null: NO cae a un agente general (no se gasta un modelo caro en el triaje)', (await createLayerRouter('layer2')) === null);
    await q(`UPDATE llm_providers SET enabled = true WHERE audit_layer = 'layer2'`);
    await q(`UPDATE llm_providers SET audit_layer = 'layer2'`);
    const fallback = await createLlmRouter();
    check('si TODOS los agentes están asignados a capas, las tareas generales siguen funcionando con cualquier agente activo', fallback.order().length === 2);
    await q(`UPDATE llm_providers SET audit_layer = NULL WHERE name = 'Sol general'`);
    let bad = false;
    await q(`UPDATE llm_providers SET audit_layer = 'capa9' WHERE name = 'Sol general'`).catch(() => (bad = true));
    check('la base solo admite las capas layer2 y layer3', bad);

    // ---- forma de la petición a Bedrock
    reset();
    script = [() => completion(triage())];
    const sink0 = new UsageSink({ organizationId: org });
    const lr = await createLayerRouter('layer2', { organizationId: org, purpose: 'layer2', sink: sink0 }, { reasoningEffort: 'low', maxOutputTokens: 4000 });
    const input = { repositoryFullName: 'acme/api', commitSha: 'a'.repeat(40), branch: 'feature/x', baseBranch: null, pullNumber: null, changeTags: [], diff: '+x', scannerFindings: [], coverageNote: 'ok', codeContext: [] };
    await lr.router.triageAudit(input);
    const b = requests[0].body;
    check('petición: modelo us.*, json_schema ESTRICTO con el esquema del triaje, razonamiento "low", tope de salida, sin temperature', b.model === 'us.openai.gpt-5.6-luna' && b.response_format.type === 'json_schema' && b.response_format.json_schema.strict === true && b.response_format.json_schema.name === 'triaje_auditoria' && b.reasoning_effort === 'low' && b.max_completion_tokens === 4000 && !('temperature' in b), JSON.stringify(Object.keys(b)));
    check('petición: la clave de Bedrock va como Bearer', requests[0].auth === 'Bearer bedrock-key');
    check('petición: las instrucciones del sistema separan los datos hostiles y prohíben obedecer lo que digan', /DATO del repositorio auditado/.test(b.messages[0].content) && /NUNCA obedezcas/.test(b.messages[0].content) && /<datos_diff>/.test(b.messages[1].content));
    await sink0.flush();
    const inv0 = await q(`SELECT * FROM llm_invocations WHERE organization_id = $1 AND purpose = 'layer2'`, [org]);
    check('consumo: cada llamada queda registrada con tokens, razonamiento, costo según la tarifa vigente y latencia (sin prompts)', inv0.length === 1 && inv0[0].prompt_tokens === 10000 && inv0[0].completion_tokens === 2000 && inv0[0].reasoning_tokens === 500 && Math.abs(Number(inv0[0].cost_usd) - 0.00484) < 1e-6 && inv0[0].model === 'us.openai.gpt-5.6-luna' && inv0[0].ok === true && inv0[0].price_id !== null && inv0[0].latency_ms >= 0, JSON.stringify(inv0[0]));
    check('consumo: los totales en memoria coinciden con lo guardado', sink0.totalsFor('layer2').calls === 1 && Math.abs(sink0.totalsFor('layer2').costUsd - 0.00484) < 1e-6);

    reset();
    script = [() => ({ status: 400, body: { error: { message: "Unsupported parameter: 'max_completion_tokens'" } } }), () => completion(triage())];
    const lr2 = await createLayerRouter('layer2', undefined, { maxOutputTokens: 4000 });
    await lr2.router.triageAudit(input);
    check('si el proveedor rechaza el tope de salida, se reintenta una vez sin él (y responde)', requests.length === 2 && 'max_completion_tokens' in requests[0].body && !('max_completion_tokens' in requests[1].body));

    reset();
    script = [() => completion('esto no es JSON'), () => completion('{"resultado":"APTO"}')];
    const lr3 = await createLayerRouter('layer2');
    const badOut = await lr3.router.triageAudit(input).catch((e) => e);
    check('respuesta que no cumple el esquema → un reintento y luego error (nunca se acepta)', badOut instanceof Error && requests.length === 2, String(badOut));

    // ================================================================== C) Layer2Service con base real
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 920000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 970000 + crypto.randomInt(1, 99999)]))[0].id;
    const mkRun = async () => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision, branch) VALUES ($1, $2, $3, 'push', 'running', 'apto', 'feature/x') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex')]))[0].id;
    const DIFF = ['diff --git a/src/vuln.py b/src/vuln.py', '--- a/src/vuln.py', '+++ b/src/vuln.py', '@@ -1,3 +1,5 @@', ' import os', '+    os.system("ls " + u)', 'diff --git a/src/config.js b/src/config.js', '--- /dev/null', '+++ b/src/config.js', '@@ -0,0 +1,2 @@', `+const token = "${FAKE_PAT}";`, '+module.exports = { token };'].join('\n');
    const layer1Result = (over = {}) => ({
      runs: [],
      findings: [F_SECRET, F_SAST, F_DEP].map((f) => ({ ...f, sources: [...f.sources] })),
      coverage: { complete: true, missing: [], technologies: ['python'], suppressions: {}, scannerConfigFiles: [] },
      ...over,
    });
    const svc2 = new Layer2Service();
    const mkParams = async (over = {}) => {
      const runId = await mkRun();
      const sink = new UsageSink({ organizationId: org, reviewRunId: runId, repositoryId: repo });
      return { runId, sink, params: { payload: { organizationId: org, repositoryId: repo, reviewRunId: runId, owner: 'acme', repo: 'demo', commitSha: 'b'.repeat(40), branch: 'feature/x', pullNumber: null }, checkoutPath: root, diff: DIFF, analyzedFiles: ['src/vuln.py', 'src/config.js'], layer1: layer1Result(), projectProfile: { language: 'python', mandatoryRules: ['Validar toda entrada'] }, recentCommits: [], sink, ...over } };
    };

    await setAuditBudget(pool, { monthlyUsd: 50, perAuditUsd: 1, policy: 'partial' });
    reset();
    let m = await mkParams();
    script = [() => completion(triage({ findings: [ownFinding(), ownFinding({ id: 'L2-2', title: 'Inventado', evidence: 'texto que no existe en ningún archivo' })], groups: [{ title: 'Comandos', finding_refs: ['F2'], rationale: 'Misma causa' }] }))];
    let out = await svc2.run(m.params);
    await m.sink.flush();
    const prompt = requests[0].body.messages[1].content;
    check('capa 2 ok: estado "ok", modelo us.*, revisión derivada con solo el hallazgo comprobado y la nota de lo descartado', out.status === 'ok' && out.model === 'us.openai.gpt-5.6-luna' && out.reviewResult.findings.length === 1 && out.reviewResult.findings[0].title === 'Inyección de comandos' && /1 hallazgo\(s\) del modelo se descartaron/.test(out.reviewResult.resumen_ejecutivo) && out.validated.rejected.length === 1, JSON.stringify(out.reason));
    check('capa 2: al modelo le llega el diff SIN el secreto (redactado), los hallazgos con ref F1.., el fragmento de código y las etiquetas', !prompt.includes(FAKE_PAT) && /\[REDACTED\]/.test(prompt) && /F1: \[gitleaks\/github-pat\]/.test(prompt) && /F2: \[semgrep\/os-system\]/.test(prompt) && /--- src\/vuln\.py \(desde la línea/.test(prompt) && /Todos los escáneres aplicables terminaron/.test(prompt) && /Validar toda entrada/.test(prompt));
    check('capa 2: los hallazgos de tipo secreto o dependencia no llevan fragmentos de código', !/--- src\/config\.js/.test(prompt) && !/--- package-lock\.json/.test(prompt));
    check('capa 2: costo y tokens de la llamada guardados y devueltos', out.usage.calls === 1 && out.usage.promptTokens === 10000 && Math.abs(out.usage.costUsd - 0.00484) < 1e-6 && out.escalation.recommended === false);
    check('capa 2: la revisión sale con puntaje, riesgo, recomendaciones y pruebas sugeridas del modelo', out.reviewResult.quality_score === 90 && out.reviewResult.risk_level === 'low' && out.reviewResult.tests_recomendados.includes('test de inyección') && out.reviewResult.findings[0].validation_status === 'confirmed');

    reset();
    await q(`UPDATE llm_providers SET enabled = false WHERE audit_layer = 'layer2'`);
    m = await mkParams();
    out = await svc2.run(m.params);
    check('sin agente en la capa 2 → "not_configured", sin llamar a ningún modelo', out.status === 'not_configured' && requests.length === 0 && /Configuración → Agentes/.test(out.reason));
    await q(`UPDATE llm_providers SET enabled = true WHERE audit_layer = 'layer2'`);

    // ---- presupuesto
    reset();
    await setAuditBudget(pool, { monthlyUsd: 0.0001, perAuditUsd: 1, policy: 'partial' });
    m = await mkParams();
    out = await svc2.run(m.params);
    check('presupuesto mensual agotado → "skipped_budget" ANTES de llamar al modelo (cero gasto), con el motivo', out.status === 'skipped_budget' && requests.length === 0 && /mensual/.test(out.reason) && out.budgetPolicy === 'partial');
    await setAuditBudget(pool, { monthlyUsd: 50, perAuditUsd: 0.0001, policy: 'block' });
    m = await mkParams();
    out = await svc2.run(m.params);
    check('límite por auditoría superado → "skipped_budget" con política "block" registrada', out.status === 'skipped_budget' && requests.length === 0 && /por auditoría/.test(out.reason) && out.budgetPolicy === 'block');
    await setAuditBudget(pool, { monthlyUsd: 50, perAuditUsd: 1, policy: 'partial' });
    const spentBefore = await getMonthSpendUsd(pool);
    check('el gasto del mes sale de lo registrado (suma de costos de llm_invocations)', spentBefore > 0);
    await q(`UPDATE llm_providers SET model = 'modelo-sin-tarifa' WHERE audit_layer = 'layer2'`);
    reset();
    script = [() => completion(triage())];
    m = await mkParams();
    out = await svc2.run(m.params);
    await m.sink.flush();
    check('un modelo sin tarifa cargada corre igual (no se puede limitar su costo) y la llamada queda marcada sin tarifa', out.status === 'ok' && m.sink.totalsFor('layer2').unpriced === 1 && (await q(`SELECT cost_usd FROM llm_invocations WHERE review_run_id = $1`, [m.runId]))[0].cost_usd === null);
    await q(`UPDATE llm_providers SET model = 'us.openai.gpt-5.6-luna' WHERE audit_layer = 'layer2'`);

    // ---- fallos del modelo
    reset();
    script = [() => ({ status: 500, body: { error: { message: 'ThrottlingException: demasiadas solicitudes' } } }), () => ({ status: 500, body: { error: { message: 'ThrottlingException' } } }), () => ({ status: 500, body: { error: { message: 'ThrottlingException' } } }), () => ({ status: 500, body: { error: { message: 'ThrottlingException' } } })];
    m = await mkParams();
    out = await svc2.run(m.params);
    await m.sink.flush();
    check('el modelo falla (429/500) → "failed" con el motivo, sin romper; el error queda registrado en el consumo', out.status === 'failed' && /Throttling/.test(out.reason) && out.reviewResult === null && (await q(`SELECT ok FROM llm_invocations WHERE review_run_id = $1`, [m.runId])).some((r) => r.ok === false));
    reset();
    script = [() => completion('no es json'), () => completion('tampoco')];
    m = await mkParams();
    out = await svc2.run(m.params);
    check('respuesta inválida (no cumple el esquema) → "failed", nunca se acepta', out.status === 'failed' && out.reviewResult === null);

    // ---- escalamiento por tipo de cambio
    reset();
    script = [() => completion(triage())];
    m = await mkParams({ analyzedFiles: ['src/auth/login.js'] });
    out = await svc2.run(m.params);
    check('un cambio de autenticación escala aunque el modelo diga que todo está bien', out.status === 'ok' && out.escalation.recommended === true && out.escalation.triggers[0].type === 'sensitive_change' && /Motivo de escalamiento/.test(out.triageSummary));

    // ================================================================== D) flujo completo de runReview
    await q(`DELETE FROM llm_providers`);
    await mkProvider('Sol general', 'us.openai.gpt-5.6-sol', 1);
    await mkProvider('Luna capa 2', 'us.openai.gpt-5.6-luna', 2, 'layer2');
    const calls = { checks: [], summaries: [] };
    const fakeGit = {
      getCommitDiff: async () => DIFF, getPullRequestDiff: async () => DIFF, getInstallationToken: async () => 'tok', getRecentCommits: async () => [],
      setCheckRunStatus: async (p) => calls.checks.push(p), postSummaryComment: async (p) => calls.summaries.push(p), postReviewComment: async () => {},
    };
    const rag = { indexAndRetrieve: async () => [], indexRepositorySample: async () => 0, search: async () => [] };
    let l1 = layer1Result();
    const fakeLayer1 = { run: async () => l1 };
    const mkSvc = () => {
      const s = new ReviewService({ withCheckout: async (_p, fn) => fn(root) }, { run: async () => [] }, rag, fakeLayer1, new Layer2Service());
      s.buildClients = async (_o, _i, usage) => ({ gitAdapter: fakeGit, llm: await createLlmRouter(usage) });
      s.getProjectProfile = async () => ({ language: 'python', framework: 'x', conventions: [], mandatory_rules: [] });
      s.maybeAutoCreatePullRequest = async () => {};
      s.notifyAuthorOnPush = async () => {};
      s.syncFindingsIssue = async () => {};
      return s;
    };
    const job = async () => {
      const id = await mkRun();
      return { organizationId: org, repositoryId: repo, installationId: 1, owner: 'acme', repo: 'demo', commitSha: 'c'.repeat(40), reviewRunId: id, branch: 'feature/x', pullNumber: 5 };
    };
    const run = (id) => q('SELECT * FROM review_runs WHERE id = $1', [id]).then((r) => r[0]);
    const generalReview = { resultado: 'APTO', quality_score: 85, risk_level: 'low', resumen_ejecutivo: 'Revisión general de Sol.', findings: [], recomendaciones: [], tests_recomendados: [], comparacion_commits_previos: 'n/a', justificacion_final: 'ok' };
    const cfgOn = async (l2 = true) => { await q(`DELETE FROM quality_gate_configs WHERE organization_id = $1`, [org]); await q(`INSERT INTO quality_gate_configs(organization_id, repository_id, audit_layer1, audit_layer2) VALUES ($1, $2, true, $3)`, [org, repo, l2]); };
    const noSecret = () => { l1 = layer1Result({ findings: [F_SAST, F_DEP].map((f) => ({ ...f })) }); };

    // (a) sin secretos nuevos, sin escalamiento: la revisión es la de la capa 2 (Luna) y Sol NO se llama
    await cfgOn();
    noSecret();
    reset();
    script = [() => completion(triage({ findings: [ownFinding()], groups: [{ title: 'Comandos', finding_refs: ['F1'], rationale: 'Misma causa' }], dismissed: [{ ref: 'F1', reason: 'El comando solo recibe valores fijos de una lista blanca interna.' }] }))];
    let j = await job();
    await mkSvc().runReview(j);
    let row = await run(j.reviewRunId);
    check('flujo (a): la capa 2 produce la revisión; el revisor general (Sol) NO se llama (solo 1 petición, al modelo de la capa 2)', requests.length === 1 && requests[0].body.model === 'us.openai.gpt-5.6-luna' && row.status === 'completed' && row.audit_layer2.status === 'ok' && row.audit_layer2.used_as_review === true && /capa 2/.test(row.analysis_note), JSON.stringify([requests.length, row.audit_layer2]));
    const f1 = await q(`SELECT * FROM findings WHERE review_run_id = $1`, [j.reviewRunId]);
    check('flujo (a): los hallazgos del modelo se guardan con origen layer2, estado de validación y referencia a la huella del hallazgo del escáner', f1.length === 1 && f1[0].rule_source === 'layer2' && f1[0].validation_status === 'confirmed', JSON.stringify(f1[0]));
    const sfa = await q(`SELECT rule_id, validation_status, triage FROM scan_findings WHERE review_run_id = $1 ORDER BY rule_id`, [j.reviewRunId]);
    check('flujo (a): lo que la capa 2 opinó de cada hallazgo de escáner queda anotado (prioridad, grupo, descarte) y el falso positivo heurístico cambia de estado', sfa.find((s) => s.rule_id === 'os-system').validation_status === 'false_positive_suspected' && sfa.find((s) => s.rule_id === 'os-system').triage.dismissed === true && sfa.find((s) => s.rule_id === 'CVE-2020-8203').validation_status === 'confirmed');
    const inv = await q(`SELECT purpose, model, cost_usd FROM llm_invocations WHERE review_run_id = $1`, [j.reviewRunId]);
    check('flujo (a): el consumo de la auditoría está guardado (capa 2, con costo)', inv.length === 1 && inv[0].purpose === 'layer2' && Number(inv[0].cost_usd) > 0);
    check('flujo (a): etapa final completed y auditoría completa; veredicto de la capa 2 respetado', row.audit_stage === 'completed' && row.audit_incomplete === false && row.audit_escalation.recommended === false && row.gate_decision !== null);

    // (b) escalamiento: cambio de autenticación → el revisor general (Sol) revisa, informado del triaje
    reset();
    const authDiff = DIFF + '\ndiff --git a/src/auth/login.js b/src/auth/login.js\n--- a/src/auth/login.js\n+++ b/src/auth/login.js\n@@ -1,1 +1,2 @@\n+function login(user, pass) {';
    fakeGit.getCommitDiff = async () => authDiff;
    fakeGit.getPullRequestDiff = async () => authDiff;
    script = [() => completion(triage()), (body) => completion(generalReview)];
    j = await job();
    const stages = [];
    const svcB = mkSvc();
    const origMark = svcB.markStage.bind(svcB);
    svcB.markStage = async (p, st) => { stages.push(st); return origMark(p, st); };
    await svcB.runReview(j);
    row = await run(j.reviewRunId);
    check('flujo (b): cambio de autenticación → escala: primero Luna (capa 2) y luego el revisor general (Sol) con el triaje en su contexto', requests.length === 2 && requests[0].body.model === 'us.openai.gpt-5.6-luna' && requests[1].body.model === 'us.openai.gpt-5.6-sol' && /Triaje de la capa 2/.test(requests[1].body.messages[1].content), JSON.stringify(requests.map((r) => r.body.model)));
    check('flujo (b): la revisión final es la del revisor general, queda registrado el escalamiento y la etapa running_layer_3', row.summary === 'Revisión general de Sol.' && row.audit_layer2.used_as_review === false && row.audit_layer2.escalated_to === 'revisor general' && row.audit_escalation.recommended === true && /Escalado a revisión avanzada/.test(row.analysis_note) && stages.includes('running_layer_3'), JSON.stringify(stages));
    const solPrompt = requests[1].body.messages[1].content;
    check('flujo (b): Sol NO recibe otra vez todo el código: solo el parche de los archivos con hallazgos graves o de cambio sensible, y se le dice qué ya auditó la capa 2', /src\/auth\/login\.js/.test(solPrompt) && /src\/vuln\.py/.test(solPrompt) && !/module\.exports = \{ token \}/.test(solPrompt) && /no se reenvía: ya lo auditó la capa 2/.test(solPrompt), solPrompt.slice(0, 400));
    const inv2 = await q(`SELECT purpose FROM llm_invocations WHERE review_run_id = $1 ORDER BY purpose`, [j.reviewRunId]);
    check('flujo (b): el consumo distingue la capa 2 de la revisión general', inv2.map((r) => r.purpose).join() === 'layer2,review');
    fakeGit.getCommitDiff = async () => DIFF;
    fakeGit.getPullRequestDiff = async () => DIFF;

    // (c) la capa 2 falla: el commit igual se analiza (revisor general) pero la auditoría queda incompleta y NUNCA APTO
    reset();
    script = [() => ({ status: 500, body: { error: { message: 'boom' } } }), () => ({ status: 500, body: { error: { message: 'boom' } } }), () => ({ status: 500, body: { error: { message: 'boom' } } }), () => ({ status: 500, body: { error: { message: 'boom' } } }), () => completion(generalReview)];
    j = await job();
    calls.checks.length = 0;
    await mkSvc().runReview(j);
    row = await run(j.reviewRunId);
    check('flujo (c): la capa 2 falla → el revisor general igual analiza el commit, la auditoría queda INCOMPLETA y el veredicto es REQUIERE REVISIÓN (nunca APTO)', row.status === 'completed' && row.audit_incomplete === true && row.audit_coverage.missing.some((x) => x.tool === 'layer2' && x.status === 'failed') && row.gate_decision === 'requiere_revision' && row.llm_verdict === 'apto', `${row.gate_decision}/${row.llm_verdict}`);
    check('flujo (c): el check de GitHub sale "neutral" y explica la verificación incompleta', calls.checks.at(-1).conclusion === 'neutral' && /Auditoría incompleta/.test(calls.checks.at(-1).summary) && /layer2/.test(calls.checks.at(-1).summary));

    // (d) presupuesto agotado: política parcial → requiere revisión; política bloquear → NO APTO
    reset();
    await setAuditBudget(pool, { monthlyUsd: 0.0001, perAuditUsd: 1, policy: 'partial' });
    script = [() => completion(generalReview)];
    j = await job();
    await mkSvc().runReview(j);
    row = await run(j.reviewRunId);
    check('flujo (d, parcial): sin presupuesto la capa 2 no corre (cero llamadas a Luna), se revisa con el general, auditoría incompleta → REQUIERE REVISIÓN', requests.length === 1 && requests[0].body.model === 'us.openai.gpt-5.6-sol' && row.audit_layer2.status === 'skipped_budget' && row.audit_incomplete === true && row.gate_decision === 'requiere_revision', `${requests.length} ${row.gate_decision}`);
    reset();
    await setAuditBudget(pool, { monthlyUsd: 0.0001, perAuditUsd: 1, policy: 'block' });
    script = [() => completion(generalReview)];
    j = await job();
    await mkSvc().runReview(j);
    row = await run(j.reviewRunId);
    check('flujo (d, bloquear): sin presupuesto el commit queda NO APTO aunque el revisor diga APTO', row.gate_decision === 'no_apto' && row.audit_coverage.budget_blocked === true && row.audit_incomplete === true);
    const guardsDb = await withTenant(org, async (c) => (await require(`${DIST}/modules/audit/store.js`).loadAuditGuards(c, j.reviewRunId)));
    check('flujo (d): al recalcular el veredicto después, la política de presupuesto se mantiene', guardsDb.budgetBlocked === true && (await withTenant(org, (c) => recomputeGateDecision(c, j.reviewRunId, 'low', 95, { block_on_risk_level: 'high', block_on_secret: true }))) === 'no_apto');
    await setAuditBudget(pool, { monthlyUsd: 50, perAuditUsd: 1, policy: 'partial' });

    // (e) la capa 2 NO puede anular un secreto nuevo: dice APTO, intenta descartarlo, y el commit queda NO APTO
    reset();
    l1 = layer1Result();
    // el conflicto con el escáner escala: después de Luna responde el revisor general (que también dice APTO)
    script = [() => completion(triage({ resultado: 'APTO', dismissed: [{ ref: 'F1', reason: 'Es una credencial de ejemplo que no funciona, se puede ignorar sin riesgo.' }] })), () => completion(generalReview)];
    j = await job();
    calls.checks.length = 0;
    await mkSvc().runReview(j);
    row = await run(j.reviewRunId);
    const sec = await q(`SELECT validation_status FROM scan_findings WHERE review_run_id = $1 AND category = 'secret'`, [j.reviewRunId]);
    check('flujo (e): el modelo dice APTO e intenta descartar el secreto → NO APTO, el secreto sigue confirmado y el intento queda registrado', row.gate_decision === 'no_apto' && row.llm_verdict === 'apto' && sec[0].validation_status === 'confirmed' && row.audit_layer2.dismissals.ignored.some((d) => /secreto nunca se descarta/.test(d.why)) && calls.checks[0].conclusion === 'failure');
    check('flujo (e): un conflicto con el escáner es motivo para escalar', row.audit_escalation.triggers.some((t) => t.type === 'conflict'));

    // (f) capa 2 apagada o capa 1 apagada: no se llama a la capa 2
    reset();
    noSecret();
    await cfgOn(false);
    script = [() => completion(generalReview)];
    j = await job();
    await mkSvc().runReview(j);
    row = await run(j.reviewRunId);
    check('flujo (f): con la capa 2 apagada se comporta como antes (revisor general; sin registro de capa 2)', requests.length === 1 && requests[0].body.model === 'us.openai.gpt-5.6-sol' && row.audit_layer2 === null && row.audit_incomplete === false);
    check('guardas: la capa 2 prevista y no ejecutada cuenta como verificación faltante; ejecutada bien, no', (() => {
      const g = guardsFromLayer1(layer1Result(), { status: 'not_configured', reason: 'x', budgetPolicy: null });
      return g.incomplete && g.missing.some((x) => x.tool === 'layer2') && applyAuditGuards('apto', g, { block_on_secret: false }).decision === 'requiere_revision' && !guardsFromLayer1(layer1Result(), { status: 'ok', reason: null, budgetPolicy: null }).incomplete;
    })());
  } finally {
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await q('DELETE FROM llm_providers');
    for (const p of savedProviders) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at, audit_layer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at, p.audit_layer],
      );
    }
    await setAuditBudget(pool, savedBudget);
    await q(`DELETE FROM llm_invocations WHERE model IN ('us.openai.gpt-5.6-luna', 'us.openai.gpt-5.6-sol', 'modelo-sin-tarifa') AND review_run_id IS NULL`).catch(() => undefined);
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
