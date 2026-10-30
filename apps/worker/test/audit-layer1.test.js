/* Pruebas de la auditoría por capas — capa 1 (escáneres deterministas), contra el worker COMPILADO dentro de su contenedor:
 *   A) piezas puras: redacción de secretos, rangos del diff, detección de tecnologías, parsers (con salidas reales de las
 *      herramientas), normalización/deduplicación/huellas y política,
 *   B) aislamiento: un contenedor endurecido no puede escribir, no tiene red, no es root,
 *   C) Docker real: los cinco escáneres sobre un repo con trampas (el repo intenta silenciar a los escáneres),
 *      fallos de escáner (no instalado, tiempo agotado, salida ilegible) = auditoría incompleta, nunca "limpia",
 *   D) base de datos: persistencia, guardas al recalcular el veredicto,
 *   E) flujo completo de ReviewService.runReview con la capa 1 activa (LLM y GitHub simulados).
 *
 * Uso (desde la raíz del repo, con postgres y worker levantados y Docker accesible desde el worker):
 *   docker compose exec -T worker node - < apps/worker/test/audit-layer1.test.js
 *
 * Crea una organización de prueba y un repo temporal en /workspace; los borra al terminar. Necesita red (reglas de Semgrep,
 * base de Trivy) y puede descargar imágenes la primera vez. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { withTenant } = require('@devsentinel/database');

const DIST = '/repo/apps/worker/dist';
const { redactSecrets, safeSnippet } = require(`${DIST}/common/redact.js`);
const { parseDiffRanges } = require(`${DIST}/modules/audit/diffRanges.js`);
const { detectTechnologies } = require(`${DIST}/modules/audit/techDetect.js`);
const parsers = require(`${DIST}/modules/audit/parsers.js`);
const { normalizeFindings } = require(`${DIST}/modules/audit/normalize.js`);
const { applyAuditGuards, guardsFromLayer1 } = require(`${DIST}/modules/audit/policy.js`);
const { saveLayer1, loadAuditGuards, insertSecretFindings } = require(`${DIST}/modules/audit/store.js`);
const { Layer1Service } = require(`${DIST}/modules/audit/layer1.service.js`);
const { SCANNERS } = require(`${DIST}/modules/audit/scanners.js`);
const { SandboxRunnerService } = require(`${DIST}/modules/review/sandboxRunner.service.js`);
const { recomputeGateDecision } = require(`${DIST}/common/gate.js`);
const { ReviewService } = require(`${DIST}/modules/review/review.service.js`);

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const suffix = crypto.randomBytes(3).toString('hex');
// Credenciales INVENTADAS con el formato real (para comprobar que Gitleaks las encuentra y que nunca se filtran). Se arman en
// tiempo de ejecución a partir de fragmentos: así este archivo no contiene ningún literal con forma de secreto y el escaneo de
// secretos de GitHub (push protection) no lo bloquea.
const FAKE_GITHUB_PAT = ['ghp', '_R4nd0mT0kenValu3Ab9Xy7Qw2Er5Ty8Ui0Op'].join('');
const FAKE_SLACK_BOT = ['xox', 'b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'].join('');
const FAKE_AWS_KEY = ['AKIA', 'J3Q7LZ2XK5R9WBNP'].join('');
const FAKE_PRIVATE_KEY = ['-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----'].join('');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.');
const SECRET_VALUES = [FAKE_GITHUB_PAT, FAKE_SLACK_BOT];
const ctx = { checkoutPath: '/workspace/job-x' };

(async () => {
  // ================================================================== A) piezas puras
  const red = redactSecrets(
    [
      `const aws = "${FAKE_AWS_KEY}";`,
      `const gh = "${SECRET_VALUES[0]}";`,
      `password = "hunter2hunter2"`,
      `DATABASE_URL=postgres://admin:s3cr3tpass@db.internal:5432/app`,
      `${FAKE_PRIVATE_KEY}`,
      `const jwt = "${FAKE_JWT}"`,
      `const ok = "esto es texto normal sin secretos";`,
    ].join('\n'),
  );
  check('redacción: llaves de AWS, tokens, contraseñas, URLs con credenciales, llaves privadas y JWT', !/AKIAJ3Q7|ghp_R4nd|hunter2|s3cr3tpass|MIIEowIB|dBjftJeZ/.test(red) && /\[REDACTED\]/.test(red), red);
  check('redacción: no destruye el texto normal', /esto es texto normal sin secretos/.test(red) && /db\.internal/.test(red));
  check('safeSnippet recorta y redacta', safeSnippet(`token = "abcdefghijk123456"` + 'x'.repeat(600)).length <= 402 && !/abcdefghijk123456/.test(safeSnippet(`token = "abcdefghijk123456"`)));

  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,3 +1,5 @@', ' linea1', '+nueva2', '+nueva3', ' linea4', ' linea5',
    '@@ -20,2 +22,3 @@', ' x', '-vieja', '+reemplazo', '+otra',
    'diff --git a/Dockerfile b/Dockerfile', 'new file mode 100644', '--- /dev/null', '+++ b/Dockerfile', '@@ -0,0 +1,2 @@', '+FROM node', '+USER root',
  ].join('\n');
  const dr = parseDiffRanges(diff);
  check('rangos del diff: líneas agregadas por archivo', JSON.stringify(dr.added.get('src/a.js')) === '[[2,3],[23,24]]' && JSON.stringify(dr.added.get('Dockerfile')) === '[[1,2]]' && dr.files.has('src/a.js'), JSON.stringify([...dr.added]));

  // ---- detección de tecnologías sobre un repo temporal
  const root = `/workspace/job-audit-${suffix}`;
  const w = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  w('src/leak.js', `const gh = "${SECRET_VALUES[0]}";\nconst slack = "${SECRET_VALUES[1]}";\n`);
  w('src/vuln.py', 'import os\ndef run(u):\n    os.system("ls " + u)\n    return eval(u)\ndef q(cur, name):\n    cur.execute("SELECT * FROM users WHERE name = \'" + name + "\'")\n');
  w('Dockerfile', 'FROM ubuntu:latest\nRUN apt-get update && apt-get install -y curl\nADD . /app\nUSER root\n');
  w('infra/main.tf', 'resource "aws_security_group" "open" {\n  name = "open"\n  ingress {\n    from_port = 0\n    to_port = 65535\n    protocol = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n');
  w('package.json', '{"name":"x","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}');
  w('package-lock.json', JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 2, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: { lodash: '4.17.15' } }, 'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' } }, dependencies: { lodash: { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' } } }));
  w('.github/workflows/ci.yml', 'name: ci\non: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n');
  w('k8s/deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n');
  w('docs/notes.yaml', 'titulo: nada que ver con infraestructura\n');
  w('node_modules/dep/index.js', 'module.exports = 1;');
  // trampas: el repo intenta silenciar a los escáneres
  w('.gitleaks.toml', '[allowlist]\npaths = [".*"]\n');
  w('.gitleaksignore', '.\n');
  w('.semgrepignore', 'src/\ninfra/\n');
  w('.trivyignore', 'CVE-2020-8203\nCVE-2021-23337\nCVE-2020-28500\n');
  w('.hadolint.yaml', 'ignored:\n  - DL3006\n  - DL3008\n  - DL3009\n  - DL3020\n  - DL3007\n  - DL3015\n');
  w('.checkov.yaml', 'skip-check:\n  - CKV_AWS_24\n  - CKV_AWS_260\n');
  w('Dockerfile.dev', 'FROM alpine\n# hadolint ignore=DL3018\nRUN apk add curl\n');

  const tech = await detectTechnologies(root);
  check('tecnologías: Dockerfiles, Terraform, lockfiles, IaC (workflow y Kubernetes) y lenguajes', tech.dockerfiles.sort().join() === 'Dockerfile,Dockerfile.dev' && tech.terraform && tech.lockfiles.join() === 'package-lock.json' && tech.iacFiles.includes('.github/workflows/ci.yml') && tech.iacFiles.includes('k8s/deploy.yaml') && tech.languages.includes('python') && tech.languages.includes('javascript'), JSON.stringify(tech));
  check('tecnologías: un YAML cualquiera no es IaC y node_modules no se recorre', !tech.iacFiles.includes('docs/notes.yaml') && !tech.lockfiles.some((l) => l.includes('node_modules')));
  check('tecnologías: detecta los archivos con que el repo intenta configurar escáneres', ['.gitleaks.toml', '.semgrepignore', '.trivyignore', '.hadolint.yaml', '.checkov.yaml', '.gitleaksignore'].every((f) => tech.scannerConfigFiles.includes(f)), tech.scannerConfigFiles.join());
  const noTech = await detectTechnologies((fs.mkdirSync(`${root}-vacio`, { recursive: true }), `${root}-vacio`));
  const applicable = SCANNERS.filter((s) => s.applies(noTech).applies).map((s) => s.tool);
  check('un repo sin nada reconocible solo corre Gitleaks (nada se ejecuta "por si acaso")', applicable.join() === 'gitleaks', applicable.join());
  fs.rmSync(`${root}-vacio`, { recursive: true, force: true });
  check('sin Dockerfile no aplica Hadolint; sin Terraform/IaC no aplica Checkov; sin lockfiles no aplica Trivy', !SCANNERS.find((s) => s.tool === 'hadolint').applies({ ...tech, dockerfiles: [] }).applies && !SCANNERS.find((s) => s.tool === 'checkov').applies({ ...tech, terraform: false, iacFiles: [] }).applies && !SCANNERS.find((s) => s.tool === 'trivy').applies({ ...tech, lockfiles: [] }).applies);

  // ---- parsers con salidas reales de cada herramienta
  const gl = parsers.parseGitleaks(JSON.stringify([{ RuleID: 'github-pat', Description: 'Uncovered a GitHub PAT', StartLine: 1, EndLine: 1, Match: 'REDACTED', Secret: 'REDACTED', File: '/workspace/job-x/src/leak.js' }]), ctx);
  check('gitleaks: ruta relativa, severidad crítica, confirmado, sin valor del secreto', gl.findings[0].filePath === 'src/leak.js' && gl.findings[0].severity === 'critical' && gl.findings[0].validation === 'confirmed' && gl.findings[0].snippet === undefined && gl.findings[0].category === 'secret');
  const sg = parsers.parseSemgrep(JSON.stringify({ version: '1.182.1', results: [{ check_id: 'python.lang.security.audit.eval-detected.eval-detected', path: '/workspace/job-x/src/vuln.py', start: { line: 4 }, end: { line: 4 }, extra: { message: 'eval peligroso', severity: 'WARNING', lines: 'requires login', metadata: { cwe: ['CWE-95: Eval Injection'] } } }, { check_id: 'generic.secrets.security.detected-aws-access-key-id-value', path: '/workspace/job-x/a.js', start: { line: 1 }, end: { line: 1 }, extra: { message: 'aws key', severity: 'ERROR', lines: 'const k = "AKIA..."', metadata: {} } }] }), ctx);
  check('semgrep: versión, CWE, severidad; "requires login" no es evidencia; reglas de secretos → categoría secreto sin snippet', sg.version === '1.182.1' && sg.findings[0].cwe === 'CWE-95' && sg.findings[0].severity === 'medium' && sg.findings[0].snippet === undefined && sg.findings[1].category === 'secret' && sg.findings[1].snippet === undefined);
  const tv = parsers.parseTrivy(JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Vulnerabilities: [{ VulnerabilityID: 'CVE-2020-8203', PkgName: 'lodash', InstalledVersion: '4.17.15', FixedVersion: '4.17.19', Severity: 'HIGH', Title: 'Prototype pollution' }] }] }), ctx);
  check('trivy: CVE, paquete, versión instalada y corregida', tv.findings[0].vulnId === 'CVE-2020-8203' && tv.findings[0].packageName === 'lodash' && tv.findings[0].fixedVersion === '4.17.19' && tv.findings[0].category === 'dependency');
  check('trivy: sin vulnerabilidades (Results ausente) es una salida válida y limpia', parsers.parseTrivy(JSON.stringify({ SchemaVersion: 2 }), ctx).findings.length === 0);
  const ck = parsers.parseCheckov(JSON.stringify({ check_type: 'terraform', results: { failed_checks: [{ check_id: 'CKV_AWS_24', check_name: 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 22', file_path: '/infra/main.tf', file_line_range: [1, 9], resource: 'aws_security_group.open', severity: null }] }, summary: { checkov_version: '3.4.0' } }), ctx);
  check('checkov: ruta relativa, rango, severidad por defecto media, versión', ck.findings[0].filePath === 'infra/main.tf' && ck.findings[0].lineStart === 1 && ck.findings[0].severity === 'medium' && ck.version === '3.4.0');
  const hl = parsers.parseHadolint(JSON.stringify([{ code: 'DL3007', column: 1, file: '/workspace/job-x/Dockerfile', level: 'warning', line: 1, message: 'Using latest is prone to errors' }]), ctx);
  check('hadolint: código, línea y severidad', hl.findings[0].ruleId === 'DL3007' && hl.findings[0].lineStart === 1 && hl.findings[0].severity === 'low');
  const bad = (fn, input) => { try { fn(input, ctx); return false; } catch { return true; } };
  check('salida vacía, no-JSON o con otra forma → error (jamás un resultado limpio)', bad(parsers.parseSemgrep, '') && bad(parsers.parseGitleaks, 'Error: algo falló') && bad(parsers.parseTrivy, '{"foo":1}') && bad(parsers.parseCheckov, '{"error":"x"}') && bad(parsers.parseHadolint, '{}') && bad(parsers.parseSemgrep, '{"results":"no"}'));

  // ---- normalización
  const ranges = parseDiffRanges(['diff --git a/src/leak.js b/src/leak.js', '--- a/src/leak.js', '+++ b/src/leak.js', '@@ -0,0 +1,2 @@', '+x', '+y'].join('\n'));
  const mk = (over) => ({ tool: 'gitleaks', ruleId: 'github-pat', severity: 'critical', category: 'secret', filePath: 'src/leak.js', lineStart: 1, lineEnd: 1, title: 't', message: 'm', validation: 'confirmed', ...over });
  const norm = await normalizeFindings(
    [
      mk({}),
      mk({ tool: 'semgrep', ruleId: 'generic.secrets.aws', severity: 'high', validation: 'pending_validation' }),
      mk({ ruleId: 'slack-bot-token', lineStart: 2, lineEnd: 2 }),
      mk({ tool: 'semgrep', ruleId: 'eval-detected', severity: 'medium', category: 'sast', filePath: 'src/vuln.py', lineStart: 4, lineEnd: 4, validation: 'pending_validation' }),
    ],
    root,
    ranges,
  );
  const dup = norm.find((f) => f.filePath === 'src/leak.js' && f.lineStart === 1);
  check('deduplicación: el mismo secreto reportado por Gitleaks y Semgrep es UN hallazgo con dos fuentes, confirmado y de la severidad más alta', norm.length === 3 && dup.sources.length === 2 && dup.validation === 'confirmed' && dup.severity === 'critical', JSON.stringify(norm.map((f) => [f.filePath, f.lineStart, f.sources.length])));
  check('baseline: línea agregada en el diff → nuevo; archivo fuera del diff → preexistente', dup.baseline === 'new' && norm.find((f) => f.filePath === 'src/vuln.py').baseline === 'preexisting');
  check('los secretos no llevan evidencia (ni redactada); el código sí, redactado', dup.evidence === null && /os\.system|eval/.test(norm.find((f) => f.filePath === 'src/vuln.py').evidence ?? ''));
  const fpBefore = norm.find((f) => f.filePath === 'src/vuln.py').fingerprint;
  w('src/vuln.py', '# comentario nuevo arriba\n# otro\n' + fs.readFileSync(path.join(root, 'src/vuln.py'), 'utf8'));
  const shifted = await normalizeFindings([{ ...mk({ tool: 'semgrep', ruleId: 'eval-detected', severity: 'medium', category: 'sast', filePath: 'src/vuln.py', lineStart: 6, lineEnd: 6, validation: 'pending_validation' }) }], root, null);
  check('huella estable: el mismo problema desplazado de línea conserva su huella (sirve para excepciones)', shifted[0].fingerprint === fpBefore && shifted[0].baseline === 'unknown');
  fs.writeFileSync(path.join(root, 'src/vuln.py'), fs.readFileSync(path.join(root, 'src/vuln.py'), 'utf8').split('\n').slice(2).join('\n'));
  check('ningún valor de secreto aparece en lo normalizado', !SECRET_VALUES.some((s) => JSON.stringify(norm).includes(s)));

  // ---- política
  const guard = (over) => ({ incomplete: false, missing: [], newConfirmedSecrets: 0, ...over });
  const cfgOn = { block_on_secret: true };
  check('política: secreto nuevo → NO APTO aunque el modelo diga APTO', applyAuditGuards('apto', guard({ newConfirmedSecrets: 1 }), cfgOn).decision === 'no_apto');
  check('política: con block_on_secret apagado, el secreto no fuerza el bloqueo', applyAuditGuards('apto', guard({ newConfirmedSecrets: 1 }), { block_on_secret: false }).decision === 'apto');
  check('política: auditoría incompleta no puede ser APTO → revisión', applyAuditGuards('apto', guard({ incomplete: true, missing: [{ tool: 'trivy', status: 'timeout', error: null }] }), cfgOn).decision === 'requiere_revision');
  check('política: incompleta no relaja un NO APTO ni un REQUIERE_REVISIÓN', applyAuditGuards('no_apto', guard({ incomplete: true }), cfgOn).decision === 'no_apto' && applyAuditGuards('requiere_revision', guard({ incomplete: true }), cfgOn).decision === 'requiere_revision');
  check('política: sin guardas el veredicto no cambia y no hay motivos', ['apto', 'requiere_revision', 'no_apto'].every((d) => { const r = applyAuditGuards(d, guard(), cfgOn); return r.decision === d && r.reasons.length === 0; }));
  check('política: los secretos preexistentes o con excepción no bloquean', guardsFromLayer1({ runs: [], coverage: { complete: true, missing: [], technologies: [] }, findings: [{ category: 'secret', baseline: 'preexisting', validation: 'confirmed' }, { category: 'secret', baseline: 'new', validation: 'accepted_exception' }, { category: 'secret', baseline: 'new', validation: 'false_positive_suspected' }] }).newConfirmedSecrets === 0);

  // ================================================================== B) aislamiento del contenedor
  const sandbox = new SandboxRunnerService();
  const probe = async (cmd, over = {}) =>
    sandbox.run({ image: 'alpine:3.20', cmd: ['sh', '-c', cmd], workdir: '/tmp', timeoutMs: 60_000, networkDisabled: true, hardened: { user: '65534', workspaceReadOnly: true, memoryMb: 128, env: { HOME: '/tmp' }, ...over } });
  let r = await probe('id -u; (touch /etc/x 2>&1 && echo ROOTFS_RW) || echo ROOTFS_RO; (touch /workspace/x 2>&1 && echo WS_RW) || echo WS_RO; (wget -T 3 -qO- http://1.1.1.1 >/dev/null 2>&1 && echo NET) || echo NO_NET; touch /tmp/ok && echo TMP_RW; grep -E "^CapEff" /proc/self/status');
  check('aislamiento: usuario sin privilegios, rootfs y /workspace de solo lectura, /tmp escribible, sin red, sin capabilities', /^65534$/m.test(r.stdout) && /ROOTFS_RO/.test(r.stdout) && /WS_RO/.test(r.stdout) && /NO_NET/.test(r.stdout) && /TMP_RW/.test(r.stdout) && /CapEff:\s*0+$/m.test(r.stdout), r.stdout + r.stderr);
  r = await sandbox.run({ image: 'alpine:3.20', cmd: ['sleep', '30'], workdir: '/tmp', timeoutMs: 1500, networkDisabled: true, hardened: { user: '65534' } });
  check('el contenedor que supera el tiempo se mata y se marca como tiempo agotado', r.timedOut === true);
  r = await sandbox.run({ image: 'alpine:3.20', cmd: ['sh', '-c', 'yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -c 5000000'], workdir: '/tmp', timeoutMs: 30_000, networkDisabled: true, hardened: { user: '65534', maxOutputBytes: 100_000 } });
  check('la salida se recorta al tope y se avisa (truncated)', r.truncated === true && r.stdout.length < 400_000);

  // ================================================================== C) Docker real: los cinco escáneres
  const layer1 = new Layer1Service(sandbox);
  const fullDiff = ['diff --git a/src/leak.js b/src/leak.js', '--- a/src/leak.js', '+++ b/src/leak.js', '@@ -0,0 +1,2 @@', `+const gh = "x"`, '+y', 'diff --git a/Dockerfile b/Dockerfile', '--- /dev/null', '+++ b/Dockerfile', '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
  const res = await layer1.run(root, fullDiff);
  const runOf = (t) => res.runs.find((x) => x.tool === t);
  console.log('INFO ' + res.runs.map((x) => `${x.tool}=${x.status}${x.error ? '(' + x.error.slice(0, 60) + ')' : ''}`).join(' '));
  check('los 5 escáneres aplican y terminan bien sobre el repo de prueba', res.runs.length === 5 && res.runs.every((x) => x.status === 'ok'), res.runs.map((x) => `${x.tool}:${x.status}:${x.error}`).join(' | '));
  check('cobertura completa y tecnologías detectadas', res.coverage.complete && res.coverage.missing.length === 0 && res.coverage.technologies.includes('docker'));
  check('cada ejecución deja versión fijada, digest de la imagen, reglas y duración', res.runs.every((x) => x.scannerVersion && x.imageDigest && x.image.includes('@sha256:') && x.ruleset && x.durationMs > 0));
  const by = (tool) => res.findings.filter((f) => f.sources.some((s) => s.tool === tool));
  check('Gitleaks: encuentra los 2 secretos AUNQUE el repo traiga .gitleaks.toml, .gitleaksignore (trampas)', by('gitleaks').length === 2, JSON.stringify(by('gitleaks').map((f) => f.ruleId)));
  check('Semgrep: encuentra el código inseguro AUNQUE el repo traiga .semgrepignore que oculta src/ e infra/ (trampa neutralizada)', by('semgrep').some((f) => f.filePath === 'src/vuln.py'), JSON.stringify(by('semgrep').map((f) => f.filePath + ':' + f.ruleId)));
  check('Trivy: encuentra los CVE de lodash AUNQUE el repo traiga .trivyignore', by('trivy').length >= 3 && by('trivy').every((f) => f.category === 'dependency' && f.packageName === 'lodash'), by('trivy').length + '');
  check('Checkov: encuentra los fallos de Terraform AUNQUE el repo traiga .checkov.yaml con skip-check', by('checkov').some((f) => f.ruleId === 'CKV_AWS_24' && f.filePath === 'infra/main.tf'), JSON.stringify(by('checkov').slice(0, 3).map((f) => f.ruleId)));
  check('Hadolint: encuentra los problemas del Dockerfile AUNQUE el repo traiga .hadolint.yaml (y la directiva "hadolint ignore" se cuenta)', by('hadolint').some((f) => f.ruleId === 'DL3007' && f.filePath === 'Dockerfile') && res.coverage.suppressions?.hadolint === 1, JSON.stringify([by('hadolint').map((f) => f.ruleId), res.coverage.suppressions]));
  check('el repo con archivos de configuración de escáneres queda avisado en la cobertura', res.coverage.scannerConfigFiles.length >= 6);
  check('baseline contra el diff: secretos y Dockerfile nuevos; Dockerfile.dev, dependencias e IaC preexistentes', by('gitleaks').every((f) => f.baseline === 'new') && by('hadolint').filter((f) => f.filePath === 'Dockerfile').every((f) => f.baseline === 'new') && by('hadolint').filter((f) => f.filePath === 'Dockerfile.dev').every((f) => f.baseline === 'preexisting') && by('trivy').every((f) => f.baseline === 'preexisting') && by('checkov').every((f) => f.baseline === 'preexisting'), JSON.stringify(res.findings.map((f) => [f.sources[0].tool, f.filePath, f.baseline])));
  check('NINGÚN valor de secreto en los hallazgos ni en los registros de ejecución', !SECRET_VALUES.some((s) => JSON.stringify(res).includes(s)));
  check('hallazgos ordenados: lo más grave y nuevo primero', res.findings[0].severity === 'critical' && res.findings[0].baseline === 'new');
  check('los archivos que configuran escáneres se retiraron del checkout; el resto del repo no se toca', ['.semgrepignore', '.checkov.yaml', '.hadolint.yaml', '.gitleaks.toml', '.trivyignore', '.gitleaksignore'].every((f) => !fs.existsSync(path.join(root, f))) && fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'Dockerfile')));

  // ---- fallos: una herramienta que no corre NUNCA es "sin hallazgos"
  const failing = async (env, mutate, expectTool) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const undo = mutate ? mutate() : () => {};
    try {
      return await new Layer1Service(sandbox).run(root, fullDiff);
    } finally {
      undo();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  let f1 = await failing({ AUDIT_IMAGE_HADOLINT: 'devsentinel-no-existe/hadolint:0.0.0' });
  check('imagen no disponible → "not_installed", auditoría INCOMPLETA y con ese motivo (no es un resultado limpio)', f1.runs.find((x) => x.tool === 'hadolint').status === 'not_installed' && f1.coverage.complete === false && f1.coverage.missing[0].tool === 'hadolint' && f1.runs.find((x) => x.tool === 'gitleaks').status === 'ok', JSON.stringify(f1.coverage.missing));
  check('lo que SÍ corrió se conserva aunque otro escáner falle', f1.findings.some((f) => f.sources.some((s) => s.tool === 'gitleaks')));
  const semgrepDef = SCANNERS.find((s) => s.tool === 'semgrep');
  f1 = await failing({}, () => { const old = semgrepDef.timeoutMs; semgrepDef.timeoutMs = 1500; return () => (semgrepDef.timeoutMs = old); });
  check('tiempo agotado → "timeout" e incompleta', f1.runs.find((x) => x.tool === 'semgrep').status === 'timeout' && !f1.coverage.complete && /límite/.test(f1.runs.find((x) => x.tool === 'semgrep').error), JSON.stringify(f1.runs.find((x) => x.tool === 'semgrep')));
  f1 = await failing({ AUDIT_IMAGE_TRIVY: 'alpine:3.20' });
  check('el escáner no puede ejecutarse (imagen equivocada) → "failed" con el error, incompleta', f1.runs.find((x) => x.tool === 'trivy').status === 'failed' && /not found|código/.test(f1.runs.find((x) => x.tool === 'trivy').error) && !f1.coverage.complete, JSON.stringify(f1.runs.find((x) => x.tool === 'trivy')));
  f1 = await failing({ AUDIT_OPTIONAL_SCANNERS: 'hadolint', AUDIT_IMAGE_HADOLINT: 'devsentinel-no-existe/hadolint:0.0.0' });
  check('un escáner marcado como opcional que falla no vuelve incompleta la auditoría (pero queda registrado como fallido)', f1.coverage.complete === true && f1.runs.find((x) => x.tool === 'hadolint').status === 'not_installed' && f1.runs.find((x) => x.tool === 'hadolint').mandatory === false);

  // ---- el contenedor del escáner no ve el checkout (volumen mal configurado): fallo explícito, nunca "sin hallazgos"
  const blindSandbox = { run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false }), imageDigest: async () => null };
  const blind = await new Layer1Service(blindSandbox).run(root, fullDiff);
  check('si el escáner no ve el repo clonado (volumen mal configurado) TODOS los aplicables fallan con ese motivo y la auditoría queda incompleta', blind.runs.filter((x) => x.status === 'failed').length === 5 && blind.runs.every((x) => /no ve el repositorio clonado/.test(x.error)) && !blind.coverage.complete && blind.findings.length === 0, JSON.stringify(blind.runs.map((x) => x.status)));
  check('la prueba de visibilidad no deja archivos en el repo', !fs.readdirSync(root).some((f) => f.startsWith('.devsentinel-canary')));

  // ================================================================== D) base de datos
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Audit L1', $1) RETURNING id`, [`aud-${suffix}`]))[0].id;
  try {
    const inst = (await q(`INSERT INTO github_installations(organization_id, installation_id, account_login) VALUES ($1, $2, 'acme') RETURNING id`, [org, 910000 + crypto.randomInt(1, 99999)]))[0].id;
    const repo = (await q(`INSERT INTO repositories(organization_id, github_installation_id, github_repo_id, full_name) VALUES ($1, $2, $3, 'acme/demo') RETURNING id`, [org, inst, 960000 + crypto.randomInt(1, 99999)]))[0].id;
    const mkRun = async (gate = 'apto') => (await q(`INSERT INTO review_runs(organization_id, repository_id, commit_sha, trigger, status, gate_decision, quality_score, risk_level) VALUES ($1, $2, $3, 'push', 'running', $4, 90, 'low') RETURNING id`, [org, repo, crypto.randomBytes(20).toString('hex'), gate]))[0].id;
    const cfg = { block_on_risk_level: 'high', block_on_secret: true };

    const run1 = await mkRun();
    await withTenant(org, async (c) => {
      const guards = guardsFromLayer1(res);
      await saveLayer1(c, org, run1, res, guards, ['motivo de prueba']);
      await saveLayer1(c, org, run1, res, guards, ['motivo de prueba']); // idempotente ante reintentos
    });
    const sr = await q('SELECT * FROM scanner_runs WHERE review_run_id = $1', [run1]);
    const sf = await q('SELECT * FROM scan_findings WHERE review_run_id = $1', [run1]);
    const rr = (await q('SELECT * FROM review_runs WHERE id = $1', [run1]))[0];
    check('persistencia: 5 ejecuciones y todos los hallazgos, sin duplicar al reintentar', sr.length === 5 && sf.length === res.findings.length && sr.every((x) => x.image_digest && x.scanner_version));
    check('persistencia: etapa "completed", cobertura y motivos en la revisión', rr.audit_stage === 'completed' && rr.audit_incomplete === false && rr.audit_coverage.policy_reasons[0] === 'motivo de prueba' && rr.audit_coverage.technologies.length > 0);
    check('persistencia: huella y estado de validación guardados; ningún secreto en la base', sf.every((x) => x.fingerprint.length === 64) && !SECRET_VALUES.some((s) => JSON.stringify(sf).includes(s) || JSON.stringify(sr).includes(s)));
    const guardsDb = await withTenant(org, (c) => loadAuditGuards(c, run1));
    check('guardas desde la base: secretos nuevos contados, cobertura completa', guardsDb.newConfirmedSecrets === 2 && guardsDb.incomplete === false, JSON.stringify(guardsDb));
    const inserted = await withTenant(org, (c) => insertSecretFindings(c, org, run1, res));
    const secretRows = await q(`SELECT * FROM findings WHERE review_run_id = $1`, [run1]);
    check('los secretos nuevos bloqueantes quedan también como hallazgos críticos, sin valor', inserted === 2 && secretRows.every((x) => x.blocking && x.severity === 'critical' && x.rule_source === 'gitleaks' && x.status === 'open') && !SECRET_VALUES.some((s) => JSON.stringify(secretRows).includes(s)));

    // recalcular el veredicto (tras una aclaración o reconsideración) respeta las guardas
    const gate = (runId, risk = 'low', score = 95) => withTenant(org, (c) => recomputeGateDecision(c, runId, risk, score, cfg));
    check('recalcular: un secreto nuevo sigue bloqueando aunque riesgo y score sean excelentes', (await gate(run1)) === 'no_apto');
    const run2 = await mkRun();
    check('recalcular: una revisión SIN capa 1 se comporta exactamente como antes (APTO)', (await gate(run2)) === 'apto');
    const incomplete = { ...f1, coverage: { complete: false, missing: [{ tool: 'trivy', status: 'timeout', error: 'x' }], technologies: [] }, findings: [] };
    await withTenant(org, (c) => saveLayer1(c, org, run2, { ...incomplete, runs: res.runs }, guardsFromLayer1(incomplete), []));
    check('recalcular: auditoría incompleta nunca da APTO (queda en revisión)', (await gate(run2)) === 'requiere_revision');
    check('la base rechaza estados inválidos de escáner y de etapa', await (async () => {
      let bad = 0;
      await q(`INSERT INTO scanner_runs(organization_id, review_run_id, tool, status) VALUES ($1, $2, 'semgrep', 'quizas')`, [org, run2]).catch(() => bad++);
      await q(`UPDATE review_runs SET audit_stage = 'volando' WHERE id = $1`, [run2]).catch(() => bad++);
      return bad === 2;
    })());

    // ================================================================== E) flujo completo de runReview con la capa 1 activa
    const VALID = { resultado: 'APTO', quality_score: 92, risk_level: 'low', resumen_ejecutivo: 'Todo bien según el modelo.', findings: [], recomendaciones: [], tests_recomendados: [], comparacion_commits_previos: 'n/a', justificacion_final: 'ok' };
    const calls = { llm: 0, llmInput: null, checks: [], summaries: [] };
    const llm = { reviewDiff: async (input) => { calls.llm++; calls.llmInput = input; return VALID; }, reviewUsage: () => ({ provider: 'sim', model: 'sim', failovers: [] }) };
    const fakeGit = {
      getCommitDiff: async () => fullDiff, getPullRequestDiff: async () => fullDiff, getInstallationToken: async () => 'tok',
      getRecentCommits: async () => [], setCheckRunStatus: async (p) => calls.checks.push(p), postSummaryComment: async (p) => calls.summaries.push(p), postReviewComment: async () => {},
    };
    const rag = { indexAndRetrieve: async () => [], indexRepositorySample: async () => 0, search: async () => [] };
    const checkoutStub = { withCheckout: async (_p, fn) => fn(root) };
    const mkSvc = (layer1Svc) => {
      const s = new ReviewService(checkoutStub, { run: async () => [] }, rag, layer1Svc);
      s.buildClients = async () => ({ gitAdapter: fakeGit, llm });
      s.getProjectProfile = async () => ({ language: 'js', framework: 'x', conventions: [], mandatory_rules: [] });
      s.maybeAutoCreatePullRequest = async () => {};
      s.notifyAuthorOnPush = async () => {};
      s.syncFindingsIssue = async () => {};
      return s;
    };
    const mkJob = async () => {
      const id = await mkRun('apto');
      await q(`UPDATE review_runs SET status = 'running', audit_stage = NULL WHERE id = $1`, [id]);
      return { organizationId: org, repositoryId: repo, installationId: 1, owner: 'acme', repo: 'demo', commitSha: 'a'.repeat(40), reviewRunId: id, branch: 'feature/x', pullNumber: 5 };
    };

    // 1) capa 1 apagada: nada cambia respecto a antes
    let job = await mkJob();
    await (async () => { const s = mkSvc(layer1); await s.runReview(job); })();
    let row = (await q('SELECT * FROM review_runs WHERE id = $1', [job.reviewRunId]))[0];
    check('capa 1 apagada: el flujo es el de siempre (APTO, sin etapa, sin escáneres guardados)', row.gate_decision === 'apto' && row.audit_stage === null && (await q('SELECT 1 FROM scanner_runs WHERE review_run_id = $1', [job.reviewRunId])).length === 0);

    // 2) capa 1 encendida: los secretos nuevos bloquean aunque el modelo diga APTO
    await q(`INSERT INTO quality_gate_configs(organization_id, repository_id, audit_layer1) VALUES ($1, $2, true)`, [org, repo]);
    calls.llm = 0; calls.checks.length = 0; calls.summaries.length = 0;
    job = await mkJob();
    const stages = [];
    const svc2 = mkSvc(layer1);
    const origMark = svc2.markStage.bind(svc2);
    svc2.markStage = async (p, st) => { stages.push(st); return origMark(p, st); };
    await svc2.runReview(job);
    row = (await q('SELECT * FROM review_runs WHERE id = $1', [job.reviewRunId]))[0];
    const blocking = await q(`SELECT * FROM findings WHERE review_run_id = $1 AND blocking`, [job.reviewRunId]);
    check('capa 1 encendida: el modelo dijo APTO pero hay secretos nuevos → NO APTO por política determinista', row.gate_decision === 'no_apto' && row.llm_verdict === 'apto', `${row.gate_decision}/${row.llm_verdict}`);
    check('etapas: running_layer_1 → running_layer_2 → completed, separadas del resultado', stages.join() === 'running_layer_1,running_layer_2' && row.audit_stage === 'completed' && row.status === 'completed');
    check('los secretos quedan como hallazgos bloqueantes y los escáneres/hallazgos guardados', blocking.length === 2 && (await q('SELECT 1 FROM scanner_runs WHERE review_run_id = $1', [job.reviewRunId])).length === 5 && (await q('SELECT 1 FROM scan_findings WHERE review_run_id = $1', [job.reviewRunId])).length > 5);
    check('GitHub: el check sale en failure y el motivo (secretos) aparece en el resumen del check y del PR', calls.checks[0]?.conclusion === 'failure' && /secretos? expuestos? nuevos?/.test(calls.checks[0].summary) && /secretos? expuestos? nuevos?/.test(calls.summaries[0].body), JSON.stringify(calls.checks[0]));
    const prompt = JSON.stringify(calls.llmInput.staticFindings);
    check('al modelo le llegan los hallazgos de las 5 herramientas, marcados como nuevos/preexistentes, sin valores de secretos', ['gitleaks', 'semgrep', 'trivy', 'checkov', 'hadolint'].every((t) => calls.llmInput.staticFindings.some((f) => f.tool === t)) && /nuevo en este cambio/.test(prompt) && /preexistente/.test(prompt) && !SECRET_VALUES.some((s) => prompt.includes(s)));

    // 3) capa 1 encendida, sin secretos nuevos y con un escáner caído: nunca APTO
    fs.writeFileSync(path.join(root, 'src/leak.js'), 'const limpio = 1;\n');
    process.env.AUDIT_IMAGE_HADOLINT = 'devsentinel-no-existe/hadolint:0.0.0';
    calls.checks.length = 0;
    job = await mkJob();
    await mkSvc(new Layer1Service(sandbox)).runReview(job);
    delete process.env.AUDIT_IMAGE_HADOLINT;
    row = (await q('SELECT * FROM review_runs WHERE id = $1', [job.reviewRunId]))[0];
    check('un escáner obligatorio no disponible + modelo en APTO → REQUIERE REVISIÓN con la auditoría marcada incompleta', row.gate_decision === 'requiere_revision' && row.audit_incomplete === true && row.audit_coverage.missing[0].tool === 'hadolint', `${row.gate_decision} ${JSON.stringify(row.audit_coverage?.missing)}`);
    check('GitHub: check "neutral" y explicación de la cobertura incompleta', calls.checks[0].conclusion === 'neutral' && /Auditoría incompleta/.test(calls.checks[0].summary));

    // 4) fallo duro del análisis: la etapa queda en failed
    job = await mkJob();
    const svc4 = mkSvc(layer1);
    svc4.buildClients = async () => ({ gitAdapter: fakeGit, llm: { reviewDiff: async () => { throw new Error('proveedor caído'); }, reviewUsage: () => ({}) } });
    svc4.publishAnalysisFailure = async () => {};
    await svc4.runReview(job).catch(() => undefined);
    row = (await q('SELECT * FROM review_runs WHERE id = $1', [job.reviewRunId]))[0];
    check('si el análisis falla del todo: status failed y audit_stage failed', row.status === 'failed' && row.audit_stage === 'failed', `${row.status}/${row.audit_stage}`);
    // 5) capa 1 apagada + fallo: la etapa sigue sin existir
    await q('DELETE FROM quality_gate_configs WHERE organization_id = $1', [org]);
    job = await mkJob();
    await svc4.runReview(job).catch(() => undefined);
    row = (await q('SELECT * FROM review_runs WHERE id = $1', [job.reviewRunId]))[0];
    check('capa 1 apagada + fallo: audit_stage sigue nulo', row.status === 'failed' && row.audit_stage === null);
  } finally {
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
