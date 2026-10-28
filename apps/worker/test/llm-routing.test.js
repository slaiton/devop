/* Pruebas del enrutador de agentes de IA (respaldo / intercalado) contra el worker COMPILADO, con
 * proveedores OpenAI-compatibles simulados:
 *   1) LlmRouter: orden, respaldo, enfriamiento, turnos, herramientas, uso por revisión.
 *   2) createLlmRouter con la base real (llm_providers cifrados, modo, turnos atómicos, estadísticas).
 *   3) Que la revisión guarde qué agente respondió.
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados):
 *   docker compose exec -T worker node - < apps/worker/test/llm-routing.test.js
 *
 * Guarda la configuración de agentes existente y la restaura al terminar. */
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const { encrypt } = require('@devsentinel/settings');
const {
  LlmRouter, LlmNotConfiguredError, LlmAllProvidersFailedError, AgenticReviewUnsupportedError,
  OpenAiCompatibleLlmAdapter, buildLlmRouter, temperatureFor, clearLlmCooldowns,
} = require('@devsentinel/llm-port');
const { createLlmRouter } = require('/repo/apps/worker/dist/common/llmRouter.factory.js');
const { ReviewService } = require('/repo/apps/worker/dist/modules/review/review.service.js');

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const REVIEW = (who) => ({
  resultado: 'APTO', findings: [], quality_score: 90, risk_level: 'low', resumen_ejecutivo: `respondió ${who}`,
  recomendaciones: [], tests_recomendados: [], comparacion_commits_previos: 'sin relación relevante', justificacion_final: 'ok',
});
const input = { repositoryFullName: 'acme/demo', commitSha: 'a'.repeat(40), diff: 'diff --git a/x b/x\n+y', staticFindings: [], retrievedContext: [], analyzedFiles: ['x'] };
const emptyToolbox = { definitions: [{ name: 'noop', description: 'x', parameters: { type: 'object', properties: {} } }], execute: async () => ({ ok: true, output: '', summary: '' }) };
const opts = { maxRounds: 3, maxToolCalls: 5, maxToolChars: 10000, deadlineMs: 30000 };

/** Proveedor OpenAI-compatible simulado. behavior: 'ok' | 'fail' (500) | 'no-tools' (400 si la petición trae tools). */
function mockProvider(name) {
  const state = { name, behavior: 'ok', requests: [] };
  state.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      state.requests.push({ body, auth: req.headers.authorization });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (state.behavior === 'fail') return send(500, { error: { message: `${name} caído` } });
      if (state.behavior === 'no-tools' && body.tools) return send(400, { error: { message: 'tools not supported' } });
      send(200, { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(REVIEW(name)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    });
  });
  return state;
}
const listen = (s) => new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}/v1`; r(); }));

(async () => {
  const A = mockProvider('A'), B = mockProvider('B'), C = mockProvider('C');
  await Promise.all([A, B, C].map(listen));
  const reset = () => { for (const s of [A, B, C]) { s.behavior = 'ok'; s.requests.length = 0; } };
  const cfg = (s, id = s.name.toLowerCase(), kind = 'custom', model = 'm') => ({ id, name: s.name, kind, baseUrl: s.url, model, apiKey: `sk-${s.name}` });
  const router = (list, o = {}) => buildLlmRouter(list, { mode: 'failover', cooldowns: new Map(), ...o });
  const answered = async (r) => (await r.reviewDiff(input)).resumen_ejecutivo;

  // ================================================================== 1) LlmRouter
  let r = router([cfg(A), cfg(B)]);
  check('respaldo: con el primero sano responde el primero y el respaldo no se toca', (await answered(r)) === 'respondió A' && B.requests.length === 0 && r.reviewUsage().provider === 'A' && r.reviewUsage().failovers.length === 0);
  check('la clave de cada agente viaja como Bearer', A.requests[0].auth === 'Bearer sk-A');

  reset(); A.behavior = 'fail';
  const shared = new Map();
  r = router([cfg(A), cfg(B)], { cooldowns: shared });
  check('respaldo: si el primero falla (500) responde el segundo', (await answered(r)) === 'respondió B');
  let usage = r.reviewUsage();
  check('queda constancia de quién respondió y quién falló, con el motivo', usage.provider === 'B' && usage.failovers.length === 1 && usage.failovers[0].provider === 'A' && /500|caído/.test(usage.failovers[0].error), JSON.stringify(usage));
  const aBefore = A.requests.length;
  r = router([cfg(A), cfg(B)], { cooldowns: shared });
  check('enfriamiento: el agente que falló se salta en los análisis siguientes (no se reintenta cada vez)', (await answered(r)) === 'respondió B' && A.requests.length === aBefore);

  let t = 0;
  const clock = { cooldowns: new Map(), now: () => t, cooldownMs: 1000 };
  reset(); A.behavior = 'fail'; t = 0;
  r = router([cfg(A), cfg(B)], clock); await answered(r);
  const a1 = A.requests.length; A.behavior = 'ok'; t = 500;
  r = router([cfg(A), cfg(B)], clock);
  check('enfriamiento: antes de que venza no se vuelve a probar', (await answered(r)) === 'respondió B' && A.requests.length === a1);
  t = 1500;
  r = router([cfg(A), cfg(B)], clock);
  check('enfriamiento: al vencer, el primero vuelve a ser el primero (y se recupera)', (await answered(r)) === 'respondió A');
  r = router([cfg(A), cfg(B)], clock);
  check('tras recuperarse queda libre de pausa', r.order()[0].name === 'A');

  reset(); A.behavior = 'fail'; B.behavior = 'fail';
  r = router([cfg(A), cfg(B)]);
  let err = await r.reviewDiff(input).catch((e) => e);
  check('si fallan todos → error que los lista a todos', err instanceof LlmAllProvidersFailedError && /A:/.test(err.message) && /B:/.test(err.message) && err.failures.length === 2, String(err));
  const allDown = new Map();
  await router([cfg(A), cfg(B)], { cooldowns: allDown }).reviewDiff(input).catch(() => undefined);
  const aN = A.requests.length;
  const stillDown = await router([cfg(A), cfg(B)], { cooldowns: allDown }).reviewDiff(input).catch((e) => e);
  check('si todos están en pausa, se prueban igual (de último recurso)', stillDown instanceof LlmAllProvidersFailedError && A.requests.length > aN);

  reset(); A.behavior = 'fail';
  const edited = new Map();
  await router([cfg(A), cfg(B)], { cooldowns: edited }).reviewDiff(input);
  check('A quedó en pausa tras fallar', router([cfg(A), cfg(B)], { cooldowns: edited }).order()[0].name === 'B');
  check('si el admin corrige la clave (o la URL, o el modelo) de A, su pausa se reinicia', router([{ ...cfg(A), apiKey: 'sk-A-nueva' }, cfg(B)], { cooldowns: edited }).order()[0].name === 'A' && router([{ ...cfg(A), model: 'otro-modelo' }, cfg(B)], { cooldowns: edited }).order()[0].name === 'A');

  err = await router([]).reviewDiff(input).catch((e) => e);
  check('sin agentes → LlmNotConfiguredError con instrucción clara', err instanceof LlmNotConfiguredError && /Agentes de IA/.test(err.message));

  // intercalado (round_robin)
  reset();
  const firsts = [];
  for (const turn of [0, 1, 2, 3, 4, 5]) firsts.push(await answered(router([cfg(A), cfg(B), cfg(C)], { mode: 'round_robin', turn })));
  check('intercalado: cada análisis empieza por un agente distinto, por turnos', JSON.stringify(firsts) === JSON.stringify(['respondió A', 'respondió B', 'respondió C', 'respondió A', 'respondió B', 'respondió C']), JSON.stringify(firsts));
  check('intercalado: el reparto es parejo', A.requests.length === 2 && B.requests.length === 2 && C.requests.length === 2);
  reset(); B.behavior = 'fail';
  r = router([cfg(A), cfg(B), cfg(C)], { mode: 'round_robin', turn: 1 });
  check('intercalado: si el que toca falla, sigue la rotación (B → C → A)', (await answered(r)) === 'respondió C' && r.reviewUsage().failovers[0].provider === 'B');
  r = router([cfg(A), cfg(B), cfg(C)], { mode: 'round_robin', turn: -4 });
  check('intercalado: turnos raros (negativos, enormes) no rompen el orden', r.order().length === 3 && router([cfg(A), cfg(B)], { mode: 'round_robin', turn: 10 ** 12 + 1 }).order().length === 2);
  r = router([cfg(A), cfg(B), cfg(C)], { mode: 'failover', turn: 2 });
  check('respaldo: el turno no influye (siempre empieza por el primero)', r.order()[0].name === 'A');

  // herramientas (análisis profundo)
  reset(); A.behavior = 'no-tools';
  const toolsCooldowns = new Map();
  r = router([cfg(A), cfg(B)], { cooldowns: toolsCooldowns });
  let out = await r.reviewDiffAgentic(input, emptyToolbox, opts);
  check('profundo: si el primero no soporta herramientas, lo hace el segundo', out.result.resumen_ejecutivo === 'respondió B' && r.reviewUsage().failovers[0].provider === 'A' && /soporta herramientas/.test(r.reviewUsage().failovers[0].error));
  r = router([cfg(A), cfg(B)], { cooldowns: toolsCooldowns });
  check('"no soporta herramientas" no manda al agente a pausa (sigue sirviendo para el análisis estándar)', toolsCooldowns.size === 0 && r.order()[0].name === 'A' && (await answered(r)) === 'respondió A');
  B.behavior = 'no-tools';
  err = await router([cfg(A), cfg(B)]).reviewDiffAgentic(input, emptyToolbox, opts).catch((e) => e);
  check('profundo: si NINGUNO soporta herramientas → AgenticReviewUnsupportedError (el servicio cae a estándar)', err instanceof AgenticReviewUnsupportedError, String(err));
  reset(); A.behavior = 'fail';
  out = await router([cfg(A), cfg(B)]).reviewDiffAgentic(input, emptyToolbox, opts);
  check('profundo: una caída real (500) del primero también pasa al respaldo', out.result.resumen_ejecutivo === 'respondió B');

  // callbacks y registro
  reset(); A.behavior = 'fail';
  const seen = [];
  r = router([cfg(A), cfg(B)], { onAttempt: (rec) => { seen.push(`${rec.provider}:${rec.ok}`); throw new Error('el registro falló'); } });
  check('onAttempt se llama por intento y un error en él no rompe el análisis', (await answered(r)) === 'respondió B' && JSON.stringify(seen) === JSON.stringify(['A:false', 'B:true']), JSON.stringify(seen));

  // modelos de razonamiento de OpenAI: sin temperatura
  check('temperatureFor: o3/o4/gpt-5 de OpenAI sin temperatura; el resto 0.1', temperatureFor('openai', 'o4-mini') === null && temperatureFor('openai', 'gpt-5') === null && temperatureFor('openai', 'gpt-4.1') === 0.1 && temperatureFor('deepseek', 'deepseek-chat') === 0.1 && temperatureFor('custom', 'o3') === 0.1);
  reset();
  await router([cfg(A, 'a', 'openai', 'o4-mini')]).reviewDiff(input);
  await router([cfg(B, 'b', 'openai', 'gpt-4.1')]).reviewDiff(input);
  check('un modelo de razonamiento de OpenAI NO envía temperature; gpt-4.1 sí', !('temperature' in A.requests[0].body) && B.requests[0].body.temperature === 0.1 && A.requests[0].body.response_format?.type === 'json_object');

  // ================================================================== 2) createLlmRouter con la base real
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const savedProviders = await q('SELECT * FROM llm_providers');
  const savedSettings = (await q('SELECT llm_routing_mode, llm_rr_cursor FROM system_settings WHERE id = true'))[0];
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Llm', $1) RETURNING id`, [`llm-${crypto.randomBytes(3).toString('hex')}`]))[0].id;
  try {
    await q('DELETE FROM llm_providers');
    const add = async (s, position, enabled = true, kind = 'custom') =>
      (await q(`INSERT INTO llm_providers(name, kind, base_url, model, api_key_encrypted, position, enabled) VALUES ($1, $2, $3, 'm', $4, $5, $6) RETURNING id`, [s.name, kind, s.url, encrypt(`sk-${s.name}`), position, enabled]))[0].id;
    clearLlmCooldowns();
    const idC = await add(C, 3), idA = await add(A, 1), idB = await add(B, 2), idOff = await add({ name: 'OFF', url: A.url }, 0, false);
    await q(`INSERT INTO system_settings(id, llm_routing_mode, llm_rr_cursor) VALUES (true, 'failover', 0) ON CONFLICT (id) DO UPDATE SET llm_routing_mode = 'failover', llm_rr_cursor = 0`);

    reset();
    let live = await createLlmRouter();
    check('fábrica: respeta la posición configurada (no el orden de creación) y omite los desactivados', JSON.stringify(live.order().map((p) => p.name)) === JSON.stringify(['A', 'B', 'C']));
    check('fábrica: descifra la clave de cada agente', (await answered(live)) === 'respondió A' && A.requests[0].auth === 'Bearer sk-A');

    await q(`UPDATE llm_providers SET position = CASE id WHEN $1 THEN 1 WHEN $2 THEN 2 ELSE position END`, [idB, idA]);
    live = await createLlmRouter();
    check('cambiar el orden aplica en el siguiente análisis, sin reiniciar', live.order()[0].name === 'B');
    await q(`UPDATE llm_providers SET position = CASE id WHEN $1 THEN 1 WHEN $2 THEN 2 ELSE position END`, [idA, idB]);

    reset(); A.behavior = 'fail';
    live = await createLlmRouter();
    await answered(live);
    await new Promise((res) => setTimeout(res, 150));
    const rowA = (await q('SELECT last_error, last_error_at, last_used_at FROM llm_providers WHERE id = $1', [idA]))[0];
    const rowB = (await q('SELECT last_error, last_used_at FROM llm_providers WHERE id = $1', [idB]))[0];
    check('queda registrado el último error del que falló y el último uso del que respondió', /500|caído/.test(rowA.last_error) && !!rowA.last_error_at && !!rowB.last_used_at && rowB.last_error === null, JSON.stringify({ rowA, rowB }));
    A.behavior = 'ok';

    await q(`UPDATE system_settings SET llm_routing_mode = 'round_robin', llm_rr_cursor = 0 WHERE id = true`);
    reset();
    clearLlmCooldowns();
    const lead = [];
    for (let i = 0; i < 6; i++) { const lr = await createLlmRouter(); lead.push(lr.order()[0].name); }
    check('modo intercalar: la base reparte los turnos y los análisis rotan entre los activos', new Set(lead).size === 3 && lead.slice(0, 3).sort().join() === 'A,B,C', JSON.stringify(lead));
    await q(`UPDATE system_settings SET llm_rr_cursor = 0 WHERE id = true`);
    const { nextLlmTurn } = require('@devsentinel/settings');
    const { getPool } = require('@devsentinel/database');
    const turns = await Promise.all(Array.from({ length: 12 }, () => nextLlmTurn(getPool())));
    check('los turnos son atómicos: 12 análisis simultáneos reciben 12 turnos distintos', new Set(turns).size === 12 && Math.max(...turns) === 12, JSON.stringify(turns));

    await q(`UPDATE system_settings SET llm_routing_mode = 'failover' WHERE id = true`);
    await q('UPDATE llm_providers SET enabled = false');
    err = await createLlmRouter().catch((e) => e);
    check('sin agentes activos la tarea falla con un mensaje claro', err instanceof LlmNotConfiguredError);

    // ================================================================== 3) la revisión guarda qué agente respondió
    await q("DELETE FROM llm_providers WHERE name = 'OFF'");
    await q('UPDATE llm_providers SET enabled = true, last_error = NULL');
    clearLlmCooldowns();
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 930000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 980000 + crypto.randomInt(1, 99999)]))[0].id;
    const svc = new ReviewService({}, {}, {});
    const payload = { organizationId: org, repositoryId: repo, reviewRunId: null };
    reset(); A.behavior = 'fail';
    live = await createLlmRouter();
    const result = await live.reviewDiff(input);
    const run1 = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger) VALUES ($1, $2, 'c', 'push') RETURNING id`, [org, repo]))[0].id;
    await svc.persistResult({ ...payload, reviewRunId: run1 }, result, 'apto', [], { mode: 'standard', note: null, trace: null, stats: null }, live.reviewUsage());
    const saved = (await q('SELECT llm_provider, llm_model, llm_failovers FROM review_runs WHERE id = $1', [run1]))[0];
    check('la revisión guarda qué agente respondió y cuáles fallaron antes', saved.llm_provider === 'B' && saved.llm_model === 'm' && saved.llm_failovers.length === 1 && saved.llm_failovers[0].provider === 'A' && /500|caído/.test(saved.llm_failovers[0].error), JSON.stringify(saved));
    reset();
    clearLlmCooldowns();
    live = await createLlmRouter();
    const run2 = (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger) VALUES ($1, $2, 'd', 'push') RETURNING id`, [org, repo]))[0].id;
    await svc.persistResult({ ...payload, reviewRunId: run2 }, await live.reviewDiff(input), 'apto', [], { mode: 'standard', note: null, trace: null, stats: null }, live.reviewUsage());
    const clean = (await q('SELECT llm_provider, llm_failovers FROM review_runs WHERE id = $1', [run2]))[0];
    check('sin fallas previas no se guarda lista de fallas', clean.llm_provider === 'A' && clean.llm_failovers === null);
  } finally {
    await q('DELETE FROM llm_providers');
    for (const p of savedProviders) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at],
      );
    }
    if (savedSettings) await q(`UPDATE system_settings SET llm_routing_mode = $1, llm_rr_cursor = $2 WHERE id = true`, [savedSettings.llm_routing_mode, savedSettings.llm_rr_cursor]);
    else await q('DELETE FROM system_settings WHERE id = true AND llm_provider_base_url IS NULL');
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
    for (const s of [A, B, C]) s.server.close();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
