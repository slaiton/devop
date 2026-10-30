/** Redacción de secretos: nada que parezca una credencial debe llegar a un prompt, a un log ni a la base de datos.
 * Es una red de seguridad por patrones (Gitleaks hace la detección fina): ante la duda, redacta. */

const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Bloques de llaves privadas completos
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // AWS: access key ids y sesiones temporales
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  // Tokens con prefijo conocido (GitHub, GitLab, Slack, Stripe, Google, npm, SendGrid, OpenAI/Anthropic-style, Bedrock…)
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|ABSK[A-Za-z0-9+/=]{20,})\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // URLs con credenciales: scheme://user:pass@host
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];

/** clave = valor en configuración, .env, JSON, YAML… donde la clave delata que el valor es secreto. */
const ASSIGNMENT =
  /((?:["']?[A-Za-z0-9_.-]*(?:secret|passw(?:or)?d|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*)(["']?)([^\s"',;]{6,})\2/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, scheme) => (typeof scheme === 'string' && scheme.endsWith('//') ? `${scheme}${REDACTED}@` : REDACTED));
  }
  out = out.replace(ASSIGNMENT, (_m, key: string, quote: string) => `${key}${quote}${REDACTED}${quote}`);
  return out;
}

/** Recorta y redacta un fragmento de código para usarlo como evidencia. */
export function safeSnippet(text: string, maxChars = 400): string {
  const redacted = redactSecrets(text.replace(/\t/g, '  '));
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}
