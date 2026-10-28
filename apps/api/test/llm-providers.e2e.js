/* Pruebas de la API de Agentes de IA (GET/POST/PATCH/DELETE /system-settings/llm/*): alta con presets,
 * validaciones, orden, modo (respaldo / intercalar), claves cifradas y enmascaradas, y la prueba de conexión.
 *
 * Uso (desde la raíz del repo, con postgres y api levantados, CONFIG_ENCRYPTION_KEY definida):
 *   docker compose exec -T api node - < apps/api/test/llm-providers.e2e.js
 *
 * Guarda la configuración de agentes existente y la restaura al terminar. */
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { decrypt } = require('@devsentinel/settings');

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

// Servicio OpenAI-compatible simulado para la prueba de conexión
const hits = [];
let mockMode = 'ok';
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    hits.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    if (mockMode === '401') return send(401, { error: { message: 'Incorrect API key provided' } });
    if (mockMode === '404') return send(404, { error: { message: 'The model does not exist' } });
    if (mockMode === '429') return send(429, { error: { message: 'You exceeded your current quota' } });
    if (mockMode === 'html') return send(200, '<html>no soy la API</html>');
    send(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
});

(async () => {
  await new Promise((r) => mock.listen(4012, '127.0.0.1', r));
  const MOCK = 'http://127.0.0.1:4012/v1';
  const hash = await bcrypt.hash('Passw0rd!llm', 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Llm API', $1) RETURNING id`, [`llmapi-${suffix}`]))[0].id;
  const mkUser = async (label, role) => {
    const email = `${label}-${suffix}@llmapi.test`;
    const id = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, label, hash]))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    return email;
  };
  const adminEmail = await mkUser('admin', 'admin');
  const userEmail = await mkUser('user', 'user');
  const savedProviders = await q('SELECT * FROM llm_providers');
  const savedSettings = (await q('SELECT llm_routing_mode FROM system_settings WHERE id = true'))[0];

  try {
    await q('DELETE FROM llm_providers');
    const admin = await cookieFor(adminEmail, 'Passw0rd!llm');
    const user = await cookieFor(userEmail, 'Passw0rd!llm');
    check('login de prueba', !!admin && !!user);

    check('sin sesión → 401', (await call('/system-settings/llm')).status === 401);
    check('usuario no admin → 403 (lectura y escritura)', (await call('/system-settings/llm', user)).status === 403 && (await call('/system-settings/llm/providers', user, { method: 'POST', body: {} })).status === 403);

    let r = await call('/system-settings/llm', admin);
    check('sin agentes: lista vacía y modo respaldo por defecto', r.status === 200 && r.json.providers.length === 0 && r.json.mode === 'failover', r.text);

    // ---- alta
    r = await call('/system-settings/llm/providers', admin, { method: 'POST', body: { kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4.1', apiKey: 'sk-SECRETO-OPENAI' } });
    const openai = r.json?.providers?.[0];
    check('alta de OpenAI: queda primero, activo y sin barra final en la URL', r.status === 201 && openai.position === 1 && openai.enabled === true && openai.baseUrl === 'https://api.openai.com/v1' && openai.kind === 'openai', r.text);
    check('la API nunca devuelve la clave, solo si hay una', openai.apiKeySet === true && !r.text.includes('SECRETO') && !('apiKey' in openai));
    const raw = (await q('SELECT api_key_encrypted FROM llm_providers WHERE id = $1', [openai.id]))[0].api_key_encrypted;
    check('en la base la clave está cifrada', !raw.includes('SECRETO') && decrypt(raw) === 'sk-SECRETO-OPENAI');

    await call('/system-settings/llm/providers', admin, { method: 'POST', body: { kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-ds' } });
    r = await call('/system-settings/llm/providers', admin, { method: 'POST', body: { kind: 'xai', name: 'Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', enabled: false } });
    check('cada alta va al final y se puede crear desactivada y sin clave', r.json.providers.map((p) => p.name).join() === 'OpenAI,DeepSeek,Grok' && r.json.providers.map((p) => p.position).join() === '1,2,3' && r.json.providers[2].enabled === false && r.json.providers[2].apiKeySet === false);
    const [pOpenai, pDeepseek, pGrok] = r.json.providers;

    // ---- validaciones
    const bad = async (body, re, label) => {
      const x = await call('/system-settings/llm/providers', admin, { method: 'POST', body });
      check(`alta inválida: ${label} → 400`, x.status === 400 && re.test(x.text), x.text.slice(0, 160));
    };
    await bad({ kind: 'otro', name: 'x', baseUrl: MOCK, model: 'm' }, /kind/, 'tipo desconocido');
    await bad({ kind: 'custom', name: 'x', baseUrl: 'no es una url', model: 'm' }, /URL base/, 'URL inválida');
    await bad({ kind: 'custom', name: 'x', baseUrl: 'ftp://host/v1', model: 'm' }, /http/, 'protocolo no http');
    await bad({ kind: 'custom', name: 'x', baseUrl: 'https://user:pass@host/v1', model: 'm' }, /usuario ni contraseña/, 'credenciales dentro de la URL');
    await bad({ kind: 'custom', name: 'x', baseUrl: MOCK, model: '' }, /modelo/, 'sin modelo');
    await bad({ kind: 'custom', name: '', baseUrl: MOCK, model: 'm' }, /nombre/, 'sin nombre');
    await bad({ kind: 'custom', name: 'n'.repeat(61), baseUrl: MOCK, model: 'm' }, /demasiado largo/, 'nombre larguísimo');
    check('las altas inválidas no crearon nada', (await q('SELECT count(*)::int AS n FROM llm_providers'))[0].n === 3);

    // ---- edición
    r = await call(`/system-settings/llm/providers/${pOpenai.id}`, admin, { method: 'PATCH', body: { model: 'gpt-4.1-mini', name: 'OpenAI (barato)' } });
    check('editar modelo y nombre', r.status === 200 && r.json.providers[0].model === 'gpt-4.1-mini' && r.json.providers[0].name === 'OpenAI (barato)');
    check('editar sin enviar apiKey conserva la clave guardada', decrypt((await q('SELECT api_key_encrypted FROM llm_providers WHERE id = $1', [pOpenai.id]))[0].api_key_encrypted) === 'sk-SECRETO-OPENAI');
    await call(`/system-settings/llm/providers/${pOpenai.id}`, admin, { method: 'PATCH', body: { apiKey: '' } });
    check('una clave vacía tampoco borra la guardada', (await q('SELECT api_key_encrypted FROM llm_providers WHERE id = $1', [pOpenai.id]))[0].api_key_encrypted !== null);
    await call(`/system-settings/llm/providers/${pOpenai.id}`, admin, { method: 'PATCH', body: { apiKey: 'sk-NUEVA' } });
    check('enviar apiKey la reemplaza (cifrada)', decrypt((await q('SELECT api_key_encrypted FROM llm_providers WHERE id = $1', [pOpenai.id]))[0].api_key_encrypted) === 'sk-NUEVA');
    r = await call(`/system-settings/llm/providers/${pGrok.id}`, admin, { method: 'PATCH', body: { apiKey: 'sk-grok', enabled: true } });
    check('activar y poner clave a un agente que estaba desactivado y sin clave', r.json.providers[2].enabled === true && r.json.providers[2].apiKeySet === true);
    r = await call(`/system-settings/llm/providers/${pGrok.id}`, admin, { method: 'PATCH', body: { clearApiKey: true } });
    check('clearApiKey quita la clave', r.json.providers[2].apiKeySet === false);
    r = await call(`/system-settings/llm/providers/${pDeepseek.id}`, admin, { method: 'PATCH', body: { baseUrl: 'javascript:alert(1)' } });
    check('editar con una URL inválida → 400 y no cambia', r.status === 400 && (await q('SELECT base_url FROM llm_providers WHERE id = $1', [pDeepseek.id]))[0].base_url === 'https://api.deepseek.com/v1');
    check('editar un agente que no existe → 404', (await call(`/system-settings/llm/providers/${crypto.randomUUID()}`, admin, { method: 'PATCH', body: { name: 'x' } })).status === 404);
    check('id que no es UUID → 400', (await call('/system-settings/llm/providers/no-es-uuid', admin, { method: 'PATCH', body: { name: 'x' } })).status === 400);

    // ---- orden
    r = await call('/system-settings/llm/order', admin, { method: 'PUT', body: { ids: [pGrok.id, pOpenai.id, pDeepseek.id] } });
    check('reordenar: el orden enviado pasa a ser el orden de uso', r.status === 200 && r.json.providers.map((p) => p.name).join() === 'Grok,OpenAI (barato),DeepSeek' && r.json.providers.map((p) => p.position).join() === '1,2,3', r.text);
    for (const [label, ids] of [['faltan agentes', [pGrok.id, pOpenai.id]], ['uno repetido', [pGrok.id, pGrok.id, pOpenai.id]], ['uno ajeno', [pGrok.id, pOpenai.id, crypto.randomUUID()]], ['no es lista', 'abc'], ['elementos que no son texto', [1, 2, 3]]]) {
      const x = await call('/system-settings/llm/order', admin, { method: 'PUT', body: { ids } });
      check(`reordenar con ${label} → 400`, x.status === 400, x.text.slice(0, 120));
    }
    check('un reordenamiento inválido no cambia el orden', (await call('/system-settings/llm', admin)).json.providers.map((p) => p.name).join() === 'Grok,OpenAI (barato),DeepSeek');

    // ---- modo
    r = await call('/system-settings/llm/routing', admin, { method: 'PATCH', body: { mode: 'round_robin' } });
    check('modo intercalar se guarda', r.status === 200 && r.json.mode === 'round_robin' && (await q('SELECT llm_routing_mode FROM system_settings WHERE id = true'))[0].llm_routing_mode === 'round_robin');
    r = await call('/system-settings/llm/routing', admin, { method: 'PATCH', body: { mode: 'failover' } });
    check('y se puede volver a respaldo', r.json.mode === 'failover');
    check('un modo inválido → 400', (await call('/system-settings/llm/routing', admin, { method: 'PATCH', body: { mode: 'aleatorio' } })).status === 400);

    // ---- prueba de conexión
    await call('/system-settings/llm/providers', admin, { method: 'POST', body: { kind: 'custom', name: 'Simulado', baseUrl: MOCK, model: 'mock-1', apiKey: 'sk-mock' } });
    const mockId = (await call('/system-settings/llm', admin)).json.providers.find((p) => p.name === 'Simulado').id;
    r = await call(`/system-settings/llm/providers/${mockId}/test`, admin, { method: 'POST' });
    const hit = hits.at(-1);
    check('probar: éxito con latencia y respuesta', r.status === 201 && r.json.ok === true && r.json.reply === 'ok' && r.json.latencyMs >= 0, r.text);
    check('probar: usa la URL, el modelo y la clave del agente', hit.url === '/v1/chat/completions' && hit.auth === 'Bearer sk-mock' && hit.body.model === 'mock-1' && !('temperature' in hit.body));
    check('probar con éxito registra el último uso', !!(await q('SELECT last_used_at FROM llm_providers WHERE id = $1', [mockId]))[0].last_used_at);
    for (const [mode, re, label] of [['401', /HTTP 401.*API key/, 'clave incorrecta'], ['404', /HTTP 404.*URL base y el nombre del modelo/, 'modelo/URL inexistente'], ['429', /HTTP 429.*saldo agotado/, 'sin cuota'], ['html', /formato de la API de OpenAI/, 'respuesta que no es OpenAI']]) {
      mockMode = mode;
      r = await call(`/system-settings/llm/providers/${mockId}/test`, admin, { method: 'POST' });
      check(`probar: ${label} → error explicado`, r.json.ok === false && re.test(r.json.error), r.text);
    }
    mockMode = 'ok';
    check('probar con error registra el último error', /formato/.test((await q('SELECT last_error FROM llm_providers WHERE id = $1', [mockId]))[0].last_error));
    await call('/system-settings/llm/providers', admin, { method: 'POST', body: { kind: 'custom', name: 'Muerto', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } });
    const deadId = (await call('/system-settings/llm', admin)).json.providers.find((p) => p.name === 'Muerto').id;
    r = await call(`/system-settings/llm/providers/${deadId}/test`, admin, { method: 'POST' });
    check('probar: servidor inalcanzable → error claro, no 500', r.status === 201 && r.json.ok === false && /no se pudo conectar/.test(r.json.error), r.text);
    check('probar un agente inexistente → 404', (await call(`/system-settings/llm/providers/${crypto.randomUUID()}/test`, admin, { method: 'POST' })).status === 404);

    // ---- borrado
    r = await call(`/system-settings/llm/providers/${pOpenai.id}`, admin, { method: 'DELETE' });
    const after = r.json.providers;
    check('borrar: se va el agente y las posiciones quedan consecutivas (1..n)', r.status === 200 && !after.some((p) => p.id === pOpenai.id) && after.map((p) => p.position).join() === '1,2,3,4', JSON.stringify(after.map((p) => [p.name, p.position])));
    check('borrar uno que no existe → 404', (await call(`/system-settings/llm/providers/${pOpenai.id}`, admin, { method: 'DELETE' })).status === 404);

    // ---- el formulario viejo ya no expone nada de LLM
    r = await call('/system-settings', admin);
    check('/system-settings (SMTP) ya no incluye los campos del proveedor único', r.status === 200 && !('llmModel' in r.json) && !('llmProviderBaseUrl' in r.json), r.text);
  } finally {
    await q('DELETE FROM llm_providers');
    for (const p of savedProviders) {
      await q(
        `INSERT INTO llm_providers(id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.name, p.kind, p.base_url, p.model, p.api_key_encrypted, p.position, p.enabled, p.last_used_at, p.last_error, p.last_error_at, p.created_at, p.updated_at],
      );
    }
    if (savedSettings) await q(`UPDATE system_settings SET llm_routing_mode = $1 WHERE id = true`, [savedSettings.llm_routing_mode]);
    else await q('DELETE FROM system_settings WHERE id = true AND llm_provider_base_url IS NULL AND smtp_host IS NULL');
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@llmapi.test`]);
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
    mock.close();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
