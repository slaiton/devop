/* Sonda de Amazon Bedrock con TU cuenta: comprueba, con llamadas reales y baratas, qué acepta GPT-5.6 Sol en la
 * API compatible con OpenAI de `bedrock-runtime` antes de usarlo como agente. No guarda nada y no imprime la clave.
 *
 * Uso (PowerShell, desde la raíz del repo; requiere Node 18+; la clave NO se escribe en archivos):
 *   $env:BEDROCK_API_KEY = "<clave API de Bedrock>"
 *   $env:BEDROCK_REGION  = "us-east-1"                       # opcional, por defecto us-east-1
 *   $env:BEDROCK_MODEL   = "global.openai.gpt-5.6-sol"       # opcional (o us.openai.gpt-5.6-sol)
 *   node apps/worker/test/bedrock-probe.js
 *   Remove-Item Env:BEDROCK_API_KEY
 *
 * Cada prueba cuesta centavos como mucho (respuestas de pocos tokens). */
const KEY = process.env.BEDROCK_API_KEY;
const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const MODEL = process.env.BEDROCK_MODEL || 'global.openai.gpt-5.6-sol';
const BASE = `https://bedrock-runtime.${REGION}.amazonaws.com/openai/v1`;

if (!KEY) {
  console.error('Falta BEDROCK_API_KEY (ver el encabezado de este archivo).');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const info = (name, value) => console.log(`INFO ${name}: ${value}`);

async function call(path, body, timeoutMs = 90_000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // no JSON
    }
    return { status: res.status, json, text: text.replace(KEY, '***').slice(0, 400), ms: Date.now() - started };
  } catch (err) {
    return { status: 0, json: null, text: String(err.message).replace(KEY, '***'), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
const reason = (r) => `HTTP ${r.status}: ${(r.json?.error?.message ?? r.text).toString().slice(0, 220)}`;

(async () => {
  console.log(`Endpoint: ${BASE}\nModelo:   ${MODEL}\n`);

  // 1) Autenticación + chat básico (lo mismo que hace el botón "Probar" del panel de agentes)
  let r = await call('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Responde solo con la palabra: ok' }] });
  check('1. chat/completions responde (clave, región, modelo y permisos correctos)', r.status === 200 && Boolean(r.json?.choices?.[0]?.message?.content), r.status === 200 ? `${r.ms} ms` : reason(r));
  if (r.status !== 200) {
    console.log('\nSi falla aquí, revisa: 401/403 → clave o permisos (InvokeModel sobre el perfil y sobre project/default);');
    console.log('404/ValidationException → id del perfil o región; 429 → cuota (TPM) o límite de solicitudes.');
    process.exit(1);
  }
  const usage = r.json.usage ?? {};
  info('uso reportado', JSON.stringify(usage));
  check('   la respuesta trae tokens de entrada y salida (para contabilizar costos)', Number(usage.prompt_tokens ?? usage.input_tokens) > 0 && Number(usage.completion_tokens ?? usage.output_tokens) > 0);
  info('modelo devuelto', r.json.model ?? '(no informado)');

  // 2) ¿Rechaza `temperature`? (el agente bedrock no la envía; esto solo documenta el comportamiento)
  r = await call('/chat/completions', { model: MODEL, temperature: 0.1, messages: [{ role: 'user', content: 'ok' }] });
  info('con temperature=0.1', r.status === 200 ? 'la acepta' : `la rechaza (${reason(r)})`);

  // 3) response_format json_object (lo que usan otros agentes). El agente bedrock NO lo envía.
  r = await call('/chat/completions', { model: MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Devuelve un JSON {"ok": true}' }] });
  info('con response_format=json_object', r.status === 200 ? 'lo acepta' : `lo rechaza (${reason(r)})`);

  // 4) JSON Schema estricto (la forma documentada para salida estructurada)
  r = await call('/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Clasifica este hallazgo: "SQL construido con concatenación de strings". Severidad y categoría.' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'clasificacion',
        strict: true,
        schema: {
          type: 'object',
          properties: { severidad: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] }, categoria: { type: 'string' } },
          required: ['severidad', 'categoria'],
          additionalProperties: false,
        },
      },
    },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.json?.choices?.[0]?.message?.content ?? '');
  } catch {
    // se informa abajo
  }
  check('4. JSON Schema estricto devuelve un objeto que cumple el esquema', r.status === 200 && parsed && ['info', 'low', 'medium', 'high', 'critical'].includes(parsed.severidad), r.status === 200 ? JSON.stringify(parsed) : reason(r));

  // 4b) La combinación que usa la capa 2 de la auditoría: json_schema estricto + razonamiento bajo + tope de tokens de salida
  r = await call('/chat/completions', {
    model: MODEL,
    reasoning_effort: 'low',
    max_completion_tokens: 800,
    messages: [{ role: 'user', content: 'Clasifica este hallazgo: "contraseña en texto plano en un log". Severidad y categoría.' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'clasificacion', strict: true, schema: { type: 'object', properties: { severidad: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] }, categoria: { type: 'string' }, ref: { type: ['string', 'null'] } }, required: ['severidad', 'categoria', 'ref'], additionalProperties: false } },
    },
  });
  let parsed2 = null;
  try {
    parsed2 = JSON.parse(r.json?.choices?.[0]?.message?.content ?? '');
  } catch {
    // se informa abajo
  }
  check('4b. json_schema estricto + reasoning_effort=low + max_completion_tokens (lo que usa la capa 2)', r.status === 200 && parsed2 && 'severidad' in parsed2, r.status === 200 ? JSON.stringify(parsed2 ?? r.json?.choices?.[0]) : reason(r));

  // 5) Llamada a funciones (herramientas del cliente): lo que usa el análisis profundo
  r = await call('/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Lee el archivo src/app.ts usando la herramienta.' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Lee un archivo del repo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
    tool_choice: 'auto',
  });
  const toolCall = r.json?.choices?.[0]?.message?.tool_calls?.[0];
  check('5. llamada a funciones (necesaria para el análisis profundo)', r.status === 200 && toolCall?.function?.name === 'read_file', r.status === 200 ? JSON.stringify(toolCall ?? 'el modelo no pidió la herramienta') : reason(r));
  if (r.status !== 200) {
    // Con razonamiento activo (por defecto) Bedrock no admite herramientas en /chat/completions; con 'none' sí.
    r = await call('/chat/completions', {
      model: MODEL,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: 'Lee el archivo src/app.ts usando la herramienta.' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Lee un archivo del repo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      tool_choice: 'auto',
    });
    const tc = r.json?.choices?.[0]?.message?.tool_calls?.[0];
    check('5b. herramientas con reasoning_effort=none (lo que usa DevSentinel en el análisis profundo)', r.status === 200 && tc?.function?.name === 'read_file', r.status === 200 ? JSON.stringify(tc ?? 'el modelo no pidió la herramienta') : reason(r));
  }

  // 6) Esfuerzo de razonamiento (controla tokens de salida y costo)
  r = await call('/chat/completions', { model: MODEL, reasoning_effort: 'low', messages: [{ role: 'user', content: 'Responde solo: ok' }] });
  info('con reasoning_effort=low', r.status === 200 ? `lo acepta (${JSON.stringify(r.json?.usage ?? {})})` : `no lo acepta (${reason(r)})`);

  // 7) Forma de los errores (para el manejo de reintentos)
  r = await call('/chat/completions', { model: `${MODEL}-no-existe`, messages: [{ role: 'user', content: 'ok' }] });
  info('modelo inexistente', reason(r));

  // 8) Prueba de contexto grande moderada (≈30K tokens de entrada, ~0,12 USD): confirma que no hay un límite menor al esperado
  if (process.env.BEDROCK_PROBE_LARGE === '1') {
    const filler = 'function ejemplo() { return 42; }\n'.repeat(3000);
    r = await call('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: `${filler}\nResponde solo: ok` }] }, 180_000);
    check('8. acepta una entrada grande (~30K tokens)', r.status === 200, r.status === 200 ? JSON.stringify(r.json.usage) : reason(r));
  } else {
    info('entrada grande', 'omitida (BEDROCK_PROBE_LARGE=1 para probar ~30K tokens, ~0,12 USD)');
  }

  console.log(failures === 0 ? '\nSonda terminada: lo esencial funciona.' : `\n${failures} comprobaciones fallaron.`);
  process.exit(failures === 0 ? 0 : 1);
})();
