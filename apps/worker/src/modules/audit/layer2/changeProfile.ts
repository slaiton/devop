/** Tipo de cambio, calculado por la APLICACIÓN a partir de las rutas modificadas (no por el modelo). Sirve de contexto para el
 * triaje y de disparador para escalar a la auditoría avanzada. Las reglas son heurísticas sobre nombres de ruta. */
export type ChangeTag = 'auth' | 'iam' | 'ci_cd' | 'migration' | 'payments' | 'infra' | 'dependencies';

const RULES: { tag: ChangeTag; test: RegExp }[] = [
  { tag: 'auth', test: /(^|\/)(auth|login|logout|session|sessions|passport|jwt|oauth|saml|sso|permissions?|rbac|acl|guards?|policies|policy)([./_-]|\/|$)|(authn|authz|authoriz|authentic)/i },
  { tag: 'iam', test: /(^|\/)(iam|roles?|trust-?policy|assume-?role)([./_-]|\/|$)|(iam[_-]|[_-]iam|\.policy\.|permission[_-]?boundary)/i },
  { tag: 'ci_cd', test: /(^|\/)\.github\/(workflows|actions)\/|(^|\/)(Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|buildspec\.ya?ml|cloudbuild\.ya?ml|\.circleci\/|bitbucket-pipelines\.ya?ml)|(^|\/)(Dockerfile[^/]*|Containerfile|docker-compose[^/]*\.ya?ml)$|(^|\/)(deploy|release)[^/]*\.(sh|ya?ml)$/i },
  { tag: 'migration', test: /(^|\/)(migrations?|migrate|db\/(migrate|schema)|database\/migrations)(\/|$)|\.sql$|(^|\/)schema\.(prisma|rb)$/i },
  { tag: 'payments', test: /(payments?|billing|invoice|checkout|stripe|paypal|wompi|payu|pse|recaud|factur|cobro|pagos?|subscription|refund)/i },
  { tag: 'infra', test: /\.(tf|tfvars)(\.json)?$|(^|\/)(k8s|kubernetes|helm|charts?|terraform|cloudformation|infra|infrastructure)(\/|$)|(^|\/)Chart\.ya?ml$/i },
  { tag: 'dependencies', test: /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(json|lock)|Gemfile(\.lock)?|go\.(mod|sum)|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pom\.xml|build\.gradle[^/]*|Cargo\.(toml|lock))$/i },
];

export interface ChangeTagResult {
  tag: ChangeTag;
  files: string[];
}

export function classifyChange(files: string[]): ChangeTagResult[] {
  const out: ChangeTagResult[] = [];
  for (const rule of RULES) {
    const matched = files.filter((f) => rule.test.test(f));
    if (matched.length > 0) out.push({ tag: rule.tag, files: matched });
  }
  return out;
}
