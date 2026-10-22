/* Pruebas del análisis profundo contra el worker COMPILADO (dist) dentro de su contenedor:
 *   1) las herramientas del revisor (funcionamiento y, sobre todo, que no se puedan usar para sacar
 *      secretos ni salirse del repo),
 *   2) el bucle de investigación del adaptador LLM contra un proveedor simulado (OpenAI-compatible),
 *   3) ReviewService.runLlmReview (estándar / profundo / caída a estándar) y la persistencia de la traza.
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados; el worker necesita git):
 *   docker compose exec -T worker node - < apps/worker/test/deep-analysis.test.js
 *
 * No usa GitHub ni LLM reales ni el índice de embeddings (se sustituyen por dobles). Crea un repo git
 * temporal en /tmp y una organización de prueba que borra al terminar. */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const REPO_DIST = '/repo/apps/worker/dist/modules/review';
const { ReviewToolbox, isDeniedPath, extractDeclaredSymbols, buildSymbolUsages, buildFileHistorySummary, formatPullRequests } = require(`${REPO_DIST}/reviewToolbox.js`);
const { truncateDiff } = require(`${REPO_DIST}/diffUtils.js`);
const { ReviewService } = require(`${REPO_DIST}/review.service.js`);
const { OpenAiCompatibleLlmAdapter, AgenticReviewUnsupportedError } = require('@devsentinel/llm-port');
const { withTenant } = require('@devsentinel/database');

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ana Dev', GIT_AUTHOR_EMAIL: 'ana@dev.test', GIT_COMMITTER_NAME: 'Ana Dev', GIT_COMMITTER_EMAIL: 'ana@dev.test' } });
const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

const VALID_REVIEW = {
  resultado: 'REQUIERE_REVISION',
  findings: [
    {
      category: 'regression', severity: 'medium', file_path: 'src/users/users.service.ts', line_start: 3, line_end: 4,
      title: 'findByEmail ya no distingue mayúsculas', explanation: 'users.controller.ts:5 lo llama con el email tal cual.',
      suggested_fix: null, confidence: 0.8, violated_rule: null,
    },
  ],
  quality_score: 72, risk_level: 'medium', resumen_ejecutivo: 'Cambio con riesgo de regresión.', recomendaciones: ['Agregar test'],
  tests_recomendados: ['users.service.spec'], comparacion_commits_previos: 'sin relación relevante', justificacion_final: 'Verificado con search_code.',
};

// ------------------------------------------------------------------ LLM simulado (OpenAI-compatible)
let llmScript = []; // cada elemento: (req) => ({status, body}) ; se consumen en orden
let llmRequests = [];
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    llmRequests.push(body);
    const step = llmScript.shift() ?? (() => ({ status: 500, body: { error: { message: 'sin guion para esta petición' } } }));
    const { status, body: out } = step(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
const completion = (message, usage = { prompt_tokens: 1000, completion_tokens: 100 }) => ({
  status: 200,
  body: { id: 'c', object: 'chat.completion', created: 1, model: 'mock', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage },
});
const toolCalls = (...calls) => () =>
  completion({ content: null, tool_calls: calls.map((c, i) => ({ id: `call_${crypto.randomBytes(3).toString('hex')}${i}`, type: 'function', function: { name: c[0], arguments: typeof c[1] === 'string' ? c[1] : JSON.stringify(c[1]) } })) });
const finalAnswer = (text) => () => completion({ content: text });

(async () => {
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${llmServer.address().port}/v1`;
  const mkLlm = () => new OpenAiCompatibleLlmAdapter('mock-model', llmUrl, 'k', async () => [0]);

  // ------------------------------------------------------------------ repo git de prueba
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-'));
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'src/users/users.service.ts', 'export class UsersService {\n  async findByEmail(email: string) {\n    return this.repo.findOne({ email });\n  }\n}\n');
  write(root, 'src/users/users.controller.ts', "import { UsersService } from './users.service';\nexport class UsersController {\n  constructor(private readonly users: UsersService) {}\n  get(email: string) {\n    return this.users.findByEmail(email);\n  }\n}\n");
  write(root, 'README.md', '# Demo\n');
  write(root, '.env', 'API_KEY=SUPERSECRET-123\n');
  write(root, '.env.example', 'API_KEY=changeme\n');
  write(root, 'certs/server.pem', '-----BEGIN PRIVATE KEY-----\nSUPERSECRET-KEY\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(1_600_000));
  fs.symlinkSync('/etc/passwd', path.join(root, 'link-out'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: usuarios');
  write(root, 'src/users/users.service.ts', 'export class UsersService {\n  async findByEmail(email: string) {\n    return this.repo.findOne({ email: email.toLowerCase() });\n  }\n}\n');
  git(root, 'commit', '-q', '-am', 'fix: normaliza el email');
  write(root, '.env', 'API_KEY=SUPERSECRET-456\n');
  write(root, 'src/users/users.service.ts', 'export class UsersService {\n  async findByEmail(email: string) {\n    return this.repo.findOne({ email: email.trim().toLowerCase() });\n  }\n}\n');
  git(root, 'commit', '-q', '-am', 'chore: trim + rota la clave');
  const headSha = git(root, 'rev-parse', 'HEAD').trim();
  const prevSha = git(root, 'rev-parse', 'HEAD~1').trim();
  write(root, '.gitleaks-report.json', '[{"Secret":"SUPERSECRET-LEAK"}]'); // lo deja el análisis estático, sin versionar

  const remoteCalls = [];
  const fakeGit = {
    readRemoteFile: async (p) => {
      remoteCalls.push(p);
      if (p.repo === 'lib-auth' && p.path === 'src/index.ts') return { kind: 'file', path: p.path, content: 'export const VERSION = 2;\n', truncated: false };
      if (p.path === 'src') return { kind: 'dir', path: 'src', entries: ['[dir] users', 'main.ts'] };
      return null;
    },
    getPullRequestContext: async () => [
      { number: 42, title: 'Normalizar emails', body: 'Evita duplicados por mayúsculas.', state: 'open', base: 'main', head: 'fix/email', author: 'ana', labels: ['bug'], comments: [{ author: 'luis', body: 'Ojo con los índices' }] },
    ],
  };
  const tools = (extra = {}) =>
    new ReviewToolbox({ checkoutPath: root, git: fakeGit, installationId: 7, owner: 'acme', repo: 'demo', commitSha: headSha, semanticSearch: async (q) => [{ filePath: 'src/users/users.service.ts', content: `parecido a: ${q}` }, { filePath: '.env', content: 'SUPERSECRET' }], ...extra });
  const T = tools();
  const run = (name, args) => T.execute(name, args);

  // ================================================================== 1) HERRAMIENTAS
  check('isDeniedPath protege .git, .env, llaves y el informe de gitleaks, y deja pasar .env.example',
    ['.git/config', 'a/.git/HEAD', '.env', 'app/.env.production', 'x/id_rsa', 'k.pem', '.npmrc', 'config/secrets.json', '.gitleaks-report.json'].every(isDeniedPath) &&
      !['.env.example', 'src/app.ts', 'docs/environment.md', '.gitignore'].some(isDeniedPath));

  let r = await run('read_file', { path: 'src/users/users.service.ts' });
  check('read_file: devuelve el archivo con números de línea', r.ok && /1\| export class UsersService/.test(r.output) && /\(5 líneas\)/.test(r.output) && /3\|.*trim\(\)\.toLowerCase/.test(r.output), r.output);
  r = await run('read_file', { path: 'src/users/users.service.ts', start_line: 2, end_line: 3 });
  check('read_file: respeta el rango pedido', r.ok && /^\s*2\|/m.test(r.output) && !/^\s*1\|/m.test(r.output) && /líneas 2-3 de 5/.test(r.summary), r.output);
  r = await run('read_file', { path: 'src/users/users.service.ts', start_line: 99 });
  check('read_file: rango fuera del archivo → error claro', !r.ok && /tiene 5 líneas/.test(r.output));
  for (const [label, p] of [['ruta con ..', '../../etc/passwd'], ['ruta absoluta', '/etc/passwd'], ['.env', '.env'], ['.git/config', '.git/config'], ['llave .pem', 'certs/server.pem'], ['informe de gitleaks', '.gitleaks-report.json'], ['symlink hacia fuera', 'link-out'], ['pathspec mágico', ':(top)README.md'], ['..  escondido', 'src/../../x']]) {
    r = await run('read_file', { path: p });
    check(`read_file: rechaza ${label}`, !r.ok && !/SUPERSECRET|root:/.test(r.output), r.output.slice(0, 120));
  }
  r = await run('read_file', { path: '.env.example' });
  check('read_file: sí permite .env.example', r.ok && /changeme/.test(r.output));
  r = await run('read_file', { path: 'bin.dat' });
  check('read_file: rechaza binarios', !r.ok && /binario/.test(r.output));
  r = await run('read_file', { path: 'big.txt' });
  check('read_file: rechaza archivos enormes', !r.ok && /demasiado grande/.test(r.output));
  r = await run('read_file', { path: 'src' });
  check('read_file: una carpeta sugiere list_dir', !r.ok && /list_dir/.test(r.output));
  r = await run('read_file', { path: 'no-existe.ts' });
  check('read_file: archivo inexistente → error', !r.ok && /no existe/.test(r.output));

  r = await run('search_code', { pattern: 'findByEmail' });
  check('search_code: encuentra definición y uso en distintos archivos', r.ok && /users\.service\.ts:2:/.test(r.output) && /users\.controller\.ts:5:/.test(r.output) && /en 2 archivos/.test(r.summary), r.output);
  r = await run('search_code', { pattern: 'SUPERSECRET' });
  check('search_code: no revela secretos de .env ni de la llave versionados', r.ok && !/SUPERSECRET-/.test(r.output), r.output);
  r = await run('search_code', { pattern: 'findByEmail(email', literal: true, path: 'src/users' });
  check('search_code: modo literal y limitado a una carpeta', r.ok && /users\.service\.ts/.test(r.output) && /users\.controller\.ts/.test(r.output), r.output);
  r = await run('search_code', { pattern: 'ZZZ_NO_EXISTE' });
  check('search_code: sin coincidencias no es un error', r.ok && /Sin coincidencias/.test(r.output));
  r = await run('search_code', { pattern: '(' });
  check('search_code: regex inválida → error, no excepción', !r.ok);
  fs.rmSync('/tmp/pwned-by-grep', { force: true });
  r = await run('search_code', { pattern: '--open-files-in-pager=touch /tmp/pwned-by-grep' });
  check('search_code: un patrón con forma de opción de git NO ejecuta nada', !fs.existsSync('/tmp/pwned-by-grep'));
  r = await run('search_code', { pattern: 'x', path: '../..' });
  check('search_code: path con .. rechazado', !r.ok);
  r = await run('search_code', { pattern: 'x', path: '.git' });
  check('search_code: path .git rechazado', !r.ok);

  r = await run('list_dir', {});
  check('list_dir: raíz sin .git, .env ni llaves; carpetas primero', r.ok && /\[dir\] src/.test(r.output) && !/\.git\b|\.env$|server\.pem|gitleaks/m.test(r.output.replace('.gitignore', '')) && /\.env\.example/.test(r.output), r.output);
  r = await run('list_dir', { path: 'src/users' });
  check('list_dir: subcarpeta', r.ok && /users\.service\.ts/.test(r.output));
  r = await run('list_dir', { path: '.git' });
  check('list_dir: .git rechazado', !r.ok);
  r = await run('list_dir', { path: '..' });
  check('list_dir: .. rechazado', !r.ok);

  r = await run('find_files', { glob: '*.service.ts' });
  check('find_files: glob sin / busca en cualquier carpeta', r.ok && /src\/users\/users\.service\.ts/.test(r.output), r.output);
  r = await run('find_files', { glob: '**/.env' });
  check('find_files: no lista archivos protegidos', !/\.env$/m.test(r.output.replace('.env.example', '')), r.output);
  r = await run('find_files', { glob: '../*' });
  check('find_files: glob con .. rechazado', !r.ok);

  r = await run('file_history', { path: 'src/users/users.service.ts' });
  check('file_history: lista los commits del archivo con autor y mensaje', r.ok && /Ana Dev: chore: trim/.test(r.output) && /fix: normaliza el email/.test(r.output) && /feat: usuarios/.test(r.output) && /3 commits/.test(r.summary), r.output);
  r = await run('file_history', { path: '.env' });
  check('file_history: archivo protegido rechazado', !r.ok);
  r = await run('file_history', { path: '--output=/tmp/x' });
  check('file_history: una ruta con forma de opción no se interpreta como opción', !fs.existsSync('/tmp/x'));

  r = await run('show_commit', { sha: prevSha });
  check('show_commit: autor, mensaje y archivos', r.ok && /Autor: Ana Dev/.test(r.output) && /fix: normaliza el email/.test(r.output) && /users\.service\.ts/.test(r.output), r.output);
  r = await run('show_commit', { sha: headSha, include_diff: true });
  check('show_commit: con diff muestra el cambio pero NO la sección de .env', r.ok && /email\.trim\(\)\.toLowerCase/.test(r.output) && !/SUPERSECRET/.test(r.output), r.output);
  for (const bad of ['--help', 'HEAD~1', 'main', '; rm -rf /', 'zzzzzzz']) {
    r = await run('show_commit', { sha: bad });
    check(`show_commit: rechaza "${bad}" (solo hashes hexadecimales)`, !r.ok);
  }
  r = await run('show_commit', { sha: 'deadbeef' });
  check('show_commit: hash inexistente → error', !r.ok);

  r = await run('blame', { path: 'src/users/users.service.ts', start_line: 3, end_line: 3 });
  check('blame: autor y commit de la línea', r.ok && /Ana Dev/.test(r.output) && /trim/.test(r.output), r.output);
  r = await run('blame', { path: 'src/users/users.service.ts', start_line: 5, end_line: 2 });
  check('blame: rango inválido → error', !r.ok);
  r = await run('blame', { path: '.env', start_line: 1, end_line: 1 });
  check('blame: archivo protegido rechazado', !r.ok);

  r = await run('semantic_search', { query: 'normalizar email' });
  check('semantic_search: devuelve fragmentos y filtra rutas protegidas', r.ok && /users\.service\.ts/.test(r.output) && !/SUPERSECRET/.test(r.output), r.output);
  r = await tools({ semanticSearch: undefined }).execute('semantic_search', { query: 'x' });
  check('semantic_search: sin índice disponible → error claro', !r.ok);

  r = await run('read_remote_file', { path: 'src/index.ts', repo: 'lib-auth', ref: 'main' });
  check('read_remote_file: lee un archivo de otro repo (mismo owner) y pasa owner/repo/ref a la API', r.ok && /VERSION = 2/.test(r.output) && remoteCalls.at(-1).owner === 'acme' && remoteCalls.at(-1).repo === 'lib-auth' && remoteCalls.at(-1).ref === 'main');
  r = await run('read_remote_file', { path: 'src' });
  check('read_remote_file: sin repo = este repo; una carpeta se lista', r.ok && /main\.ts/.test(r.output) && remoteCalls.at(-1).repo === 'demo');
  r = await run('read_remote_file', { path: 'nada.ts', repo: 'otro-owner/otro' });
  check('read_remote_file: inexistente o sin acceso → error claro', !r.ok && /no existe o la instalación no tiene acceso/.test(r.output));
  for (const args of [{ path: '.env' }, { path: 'x', repo: 'a/b/c' }, { path: 'x', repo: 'a b' }, { path: 'x', ref: 'main;rm -rf /' }, { path: '../x' }]) {
    r = await run('read_remote_file', args);
    check(`read_remote_file: rechaza ${JSON.stringify(args)}`, !r.ok);
  }
  r = await run('get_pull_request_context', {});
  check('get_pull_request_context: título, descripción, etiquetas y comentarios', r.ok && /PR #42 "Normalizar emails"/.test(r.output) && /Evita duplicados/.test(r.output) && /bug/.test(r.output) && /Ojo con los índices/.test(r.output));
  r = await run('no_existe', {});
  check('herramienta desconocida → error, sin excepción', !r.ok);

  check('extractDeclaredSymbols: detecta funciones, clases y métodos agregados (y no los de líneas borradas)',
    JSON.stringify(extractDeclaredSymbols('+export class PaymentService {\n+  async chargeCustomer(id) {}\n-  async oldMethod() {}\n+const buildInvoice = (x) => x;\n+++ b/a.ts')) === JSON.stringify(['PaymentService', 'chargeCustomer', 'buildInvoice']));
  const usages = await buildSymbolUsages(root, '+  async findByEmail(email: string) {\n', ['src/users/users.service.ts']);
  check('buildSymbolUsages: dice dónde más se usa el símbolo fuera del diff', /findByEmail: usado en 1 archivo\(s\) fuera de este diff: src\/users\/users\.controller\.ts/.test(usages), usages);
  const hist = await buildFileHistorySummary(root, ['src/users/users.service.ts', '.env']);
  check('buildFileHistorySummary: commits anteriores del archivo (sin el actual) y omite protegidos', /fix: normaliza el email/.test(hist) && !/chore: trim/.test(hist) && !/\.env/.test(hist), hist);
  const big = Array.from({ length: 6 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n${'+x\n'.repeat(400)}`).join('');
  const cut = truncateDiff(big, 3000);
  check('truncateDiff: recorta por archivos completos y nombra los omitidos', cut.diff.length <= 3100 && /f5\.ts/.test(cut.note) && /demasiado grande/.test(cut.note) && truncateDiff('corto', 100).note === undefined);
  check('formatPullRequests no revienta con PR sin descripción', /sin descripción/.test(formatPullRequests([{ number: 1, title: 't', body: '', state: 'open', base: 'a', head: 'b', author: null, labels: [], comments: [] }])));

  // ================================================================== 2) BUCLE DEL LLM
  const llm = mkLlm();
  const baseInput = { repositoryFullName: 'acme/demo', commitSha: headSha, diff: 'diff --git a/x b/x\n+y', staticFindings: [], retrievedContext: [], analyzedFiles: ['src/users/users.service.ts'], deepContext: { pullRequest: 'PR #42 Normalizar', fileHistory: 'src/users/users.service.ts\n  abc fix', symbolUsages: 'findByEmail: usado en 1 archivo' } };
  const opts = { maxRounds: 12, maxToolCalls: 40, maxToolChars: 160000, deadlineMs: 60000 };
  const reqTools = (b) => b.tools?.map((t) => t.function.name) ?? [];

  llmRequests = [];
  llmScript = [
    toolCalls(['search_code', { pattern: 'findByEmail' }], ['read_file', { path: 'src/users/users.controller.ts' }]),
    toolCalls(['file_history', { path: 'src/users/users.service.ts', limit: 2 }]),
    finalAnswer('Aquí va el veredicto:\n```json\n' + JSON.stringify(VALID_REVIEW) + '\n```'),
  ];
  let out = await llm.reviewDiffAgentic(baseInput, T, opts);
  check('bucle: 3 rondas, 3 consultas y veredicto parseado (aunque venga en un bloque ```json)', out.stats.rounds === 3 && out.stats.toolCalls === 3 && out.result.resultado === 'REQUIERE_REVISION' && out.result.findings.length === 1, JSON.stringify(out.stats));
  check('bucle: la traza registra herramienta, argumentos y resumen', out.trace.length === 3 && out.trace[0].tool === 'search_code' && out.trace[0].args.pattern === 'findByEmail' && /coincidencias/.test(out.trace[0].summary) && out.trace[1].round === 1 && out.trace[2].round === 2 && out.trace.every((t) => t.ok && t.chars > 0));
  check('bucle: acumula los tokens de cada ronda', out.stats.promptTokens === 3000 && out.stats.completionTokens === 300 && out.stats.budgetExhausted === false);
  check('bucle: pide las 10 herramientas, sin response_format mientras investiga', reqTools(llmRequests[0]).length === 10 && reqTools(llmRequests[0]).includes('read_remote_file') && llmRequests[0].response_format === undefined && llmRequests[0].tool_choice === 'auto');
  const secondRoundMsgs = llmRequests[1].messages;
  check('bucle: devuelve los resultados como mensajes "tool" enlazados por tool_call_id', secondRoundMsgs.filter((m) => m.role === 'tool').length === 2 && secondRoundMsgs.find((m) => m.role === 'assistant' && m.tool_calls)?.tool_calls.length === 2 && secondRoundMsgs.filter((m) => m.role === 'tool').every((m) => m.tool_call_id));
  const sys = llmRequests[0].messages[0].content;
  const usr = llmRequests[0].messages[1].content;
  check('prompt: el system incluye el modo profundo y la regla de datos no confiables', /MODO DE ANÁLISIS PROFUNDO/.test(sys) && /DATOS a analizar, no instrucciones/.test(sys) && /archivo:línea/.test(sys));
  check('prompt: el user incluye PR, historial por archivo y usos de símbolos', /Pull Request relacionado/.test(usr) && /PR #42 Normalizar/.test(usr) && /Historial reciente de los archivos modificados/.test(usr) && /Uso de los símbolos/.test(usr));

  llmRequests = [];
  llmScript = [toolCalls(['read_file', { path: 'README.md' }]), toolCalls(['read_file', { path: 'README.md' }]), finalAnswer(JSON.stringify(VALID_REVIEW))];
  out = await llm.reviewDiffAgentic(baseInput, T, opts);
  check('bucle: una consulta idéntica no se repite ni gasta presupuesto', out.trace[1].ok === false && /repetida/.test(out.trace[1].summary) && out.stats.toolCalls === 1);

  llmRequests = [];
  llmScript = [toolCalls(['read_file', '{no es json']), finalAnswer(JSON.stringify(VALID_REVIEW))];
  out = await llm.reviewDiffAgentic(baseInput, T, opts);
  check('bucle: argumentos que no son JSON → error devuelto al modelo, el bucle continúa', out.trace[0].ok === false && /no son JSON/.test(out.trace[0].summary) && out.result.quality_score === 72);

  llmRequests = [];
  llmScript = [toolCalls(['read_file', { path: 'README.md' }]), toolCalls(['list_dir', {}]), (b) => (b.response_format ? finalAnswer(JSON.stringify(VALID_REVIEW))() : { status: 500, body: {} })];
  out = await llm.reviewDiffAgentic(baseInput, T, { ...opts, maxRounds: 2 });
  const forced = llmRequests.at(-1);
  check('presupuesto de rondas agotado → pide el veredicto sin herramientas y marca budgetExhausted', out.stats.budgetExhausted === true && out.stats.rounds === 2 && forced.tools === undefined && forced.response_format?.type === 'json_object' && /Se agotó el presupuesto/.test(forced.messages.at(-1).content), JSON.stringify(out.stats));

  llmRequests = [];
  llmScript = [toolCalls(['read_file', { path: 'src/users/users.service.ts' }]), finalAnswer(JSON.stringify(VALID_REVIEW))];
  out = await llm.reviewDiffAgentic(baseInput, T, { ...opts, maxToolChars: 40 });
  const toolMsg = llmRequests[1].messages.find((m) => m.role === 'tool').content;
  check('tope de caracteres: el resultado de la herramienta se recorta con aviso', toolMsg.length < 120 && /recortado por el presupuesto/.test(toolMsg), toolMsg);

  llmRequests = [];
  llmScript = [toolCalls(['read_file', { path: 'README.md' }], ['list_dir', {}], ['find_files', { glob: '*.ts' }]), (b) => (b.response_format ? finalAnswer(JSON.stringify(VALID_REVIEW))() : { status: 500, body: {} })];
  out = await llm.reviewDiffAgentic(baseInput, T, { ...opts, maxToolCalls: 2 });
  check('tope de consultas: la tercera de la ronda no se ejecuta y se marca presupuesto agotado', out.stats.toolCalls === 2 && out.stats.budgetExhausted === true && out.trace[2].ok === false && /omitida/.test(out.trace[2].summary), JSON.stringify(out.stats));

  llmRequests = [];
  llmScript = [() => ({ status: 400, body: { error: { message: 'tools are not supported by this model' } } })];
  let err = await llm.reviewDiffAgentic(baseInput, T, opts).catch((e) => e);
  check('modelo sin herramientas (HTTP 400 en la 1ª ronda) → AgenticReviewUnsupportedError', err instanceof AgenticReviewUnsupportedError && /HTTP 400/.test(err.message), String(err));

  llmRequests = [];
  llmScript = [toolCalls(['list_dir', {}]), () => ({ status: 400, body: { error: { message: 'x' } } })];
  err = await llm.reviewDiffAgentic(baseInput, T, opts).catch((e) => e);
  check('un 400 en una ronda posterior NO se confunde con "sin soporte de herramientas"', err instanceof Error && !(err instanceof AgenticReviewUnsupportedError), String(err));

  llmRequests = [];
  llmScript = [finalAnswer('no sé qué responder'), (b) => (b.response_format ? finalAnswer(JSON.stringify(VALID_REVIEW))() : { status: 500, body: {} })];
  out = await llm.reviewDiffAgentic(baseInput, T, opts);
  check('veredicto que no es JSON válido → se le pide corregir y se acepta la corrección', out.result.quality_score === 72 && llmRequests.length === 2 && /no cumplió el esquema/.test(llmRequests[1].messages.at(-1).content));

  llmRequests = [];
  llmScript = [toolCalls(['search_code', { pattern: 'findByEmail' }]), () => ({ status: 500, body: { error: { message: 'boom' } } }), () => ({ status: 500, body: {} }), () => ({ status: 500, body: {} }), () => ({ status: 500, body: {} })];
  err = await llm.reviewDiffAgentic(baseInput, T, opts).catch((e) => e);
  check('error del proveedor a mitad de la investigación → se propaga (el servicio cae a estándar)', err instanceof Error && !(err instanceof AgenticReviewUnsupportedError));

  // ================================================================== 3) ReviewService.runLlmReview
  const ragCalls = { sample: 0, search: 0 };
  const ragStub = { indexRepositorySample: async () => { ragCalls.sample++; return 3; }, search: async () => { ragCalls.search++; return []; } };
  const svc = new ReviewService({}, {}, ragStub);
  const payload = { organizationId: 'org', repositoryId: 'repo', installationId: 7, owner: 'acme', repo: 'demo', commitSha: headSha, reviewRunId: 'rr' };
  const reviewInput = { ...baseInput, deepContext: undefined };
  const call = (deep, over = {}) => svc.runLlmReview({ deep, llm: mkLlm(), gitAdapter: { ...fakeGit, ...over }, payload, reviewInput, checkoutPath: root });

  llmRequests = [];
  llmScript = [finalAnswer(JSON.stringify(VALID_REVIEW))];
  let res = await call(false);
  check('estándar: una sola llamada, sin herramientas, sin traza', llmRequests.length === 1 && llmRequests[0].tools === undefined && res.analysis.mode === 'standard' && res.analysis.note === null && res.analysis.trace === null && res.result.quality_score === 72);

  llmRequests = [];
  llmScript = [toolCalls(['search_code', { pattern: 'findByEmail' }]), finalAnswer(JSON.stringify(VALID_REVIEW))];
  res = await call(true);
  const firstUser = llmRequests[0].messages[1].content;
  check('profundo: investiga y guarda modo, traza y consumo', res.analysis.mode === 'deep' && res.analysis.trace.length === 1 && res.analysis.stats.rounds === 2 && res.analysis.note === null);
  check('profundo: arma el contexto previo (PR, historial por archivo, usos de símbolos) sin gastar tokens', /PR #42 "Normalizar emails"/.test(firstUser) && /Historial reciente/.test(firstUser) && ragCalls.sample === 1);
  const searchRes = llmRequests[1].messages.find((m) => m.role === 'tool').content;
  check('profundo: las herramientas operan sobre el clon', /users\.service\.ts:2:/.test(searchRes));

  llmRequests = [];
  llmScript = [() => ({ status: 400, body: { error: { message: 'tools unsupported' } } }), finalAnswer(JSON.stringify(VALID_REVIEW))];
  res = await call(true);
  check('profundo + modelo sin herramientas → cae a estándar y lo explica', res.analysis.mode === 'standard' && /no soporta herramientas/.test(res.analysis.note) && res.analysis.trace === null && res.result.quality_score === 72 && llmRequests.at(-1).tools === undefined);

  llmRequests = [];
  llmScript = [toolCalls(['list_dir', {}]), () => ({ status: 500, body: {} }), () => ({ status: 500, body: {} }), () => ({ status: 500, body: {} }), finalAnswer(JSON.stringify(VALID_REVIEW))];
  res = await call(true);
  check('profundo + fallo a mitad de la investigación → cae a estándar con el motivo', res.analysis.mode === 'standard' && /investigación profunda falló/.test(res.analysis.note) && res.result.quality_score === 72);

  llmRequests = [];
  llmScript = [finalAnswer(JSON.stringify(VALID_REVIEW))];
  const rag0 = ragCalls.sample;
  res = await call(true, { getPullRequestContext: async () => { throw new Error('403 sin permiso de Pull requests'); } });
  check('profundo: si GitHub no da el contexto del PR, el análisis sigue sin él', res.analysis.mode === 'deep' && !/Pull Request relacionado/.test(llmRequests[0].messages[1].content) && ragCalls.sample === rag0 + 1);

  // ------------------------------------------------------------------ persistencia (BD real)
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const suffix = crypto.randomBytes(3).toString('hex');
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Deep', $1) RETURNING id`, [`deep-${suffix}`]))[0].id;
  try {
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 900000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 950000 + crypto.randomInt(1, 99999)]))[0].id;
    const mkRun = async () => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger) VALUES ($1, $2, $3, 'push') RETURNING id`, [org, repo, headSha]))[0].id;
    const p2 = { ...payload, organizationId: org, repositoryId: repo };

    llmRequests = [];
    llmScript = [toolCalls(['file_history', { path: 'README.md' }]), finalAnswer(JSON.stringify(VALID_REVIEW))];
    const deepRes = await call(true);
    const run1 = await mkRun();
    await svc.persistResult({ ...p2, reviewRunId: run1 }, deepRes.result, 'requiere_revision', ['src/users/users.service.ts'], deepRes.analysis);
    let row = (await q('SELECT * FROM review_runs WHERE id = $1', [run1]))[0];
    check('persistencia: guarda modo, traza y consumo del análisis profundo', row.analysis_mode === 'deep' && row.analysis_trace.length === 1 && row.analysis_trace[0].tool === 'file_history' && row.analysis_stats.rounds === 2 && row.analysis_stats.promptTokens === 2000 && row.analysis_note === null && row.status === 'completed', JSON.stringify(row.analysis_trace));
    check('persistencia: el veredicto y los hallazgos se guardan igual que siempre', row.quality_score === 72 && (await q('SELECT count(*)::int AS n FROM findings WHERE review_run_id = $1', [run1]))[0].n === 1);

    const run2 = await mkRun();
    await svc.persistResult({ ...p2, reviewRunId: run2 }, VALID_REVIEW, 'apto', [], { mode: 'standard', note: 'Este repo está en análisis profundo, pero ...', trace: null, stats: null });
    row = (await q('SELECT * FROM review_runs WHERE id = $1', [run2]))[0];
    check('persistencia: la caída a estándar deja el motivo y sin traza', row.analysis_mode === 'standard' && /análisis profundo/.test(row.analysis_note) && row.analysis_trace === null && row.analysis_stats === null);

    const cfg = await svc.getQualityGateConfig(org, repo);
    check('config del gate: sin configuración explícita el repo queda en estándar', !cfg.analysis_depth || cfg.analysis_depth === 'standard');
    await q(`INSERT INTO quality_gate_configs(organization_id, repository_id, analysis_depth) VALUES ($1, $2, 'deep')`, [org, repo]);
    check('config del gate: lee analysis_depth = deep del repo', (await svc.getQualityGateConfig(org, repo)).analysis_depth === 'deep');
    let rejected = false;
    await q(`UPDATE quality_gate_configs SET analysis_depth = 'turbo' WHERE repository_id = $1`, [repo]).catch(() => (rejected = true));
    check('la base rechaza valores de profundidad inválidos', rejected);
  } finally {
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
    llmServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
