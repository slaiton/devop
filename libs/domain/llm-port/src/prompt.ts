import type { ReviewDiffInput } from './types';

const SYSTEM_PROMPT = `Eres un revisor de código senior que actúa como arquitecto de software.
Analiza ÚNICAMENTE el diff proporcionado (no el repositorio completo).
Evalúa: arquitectura, Clean Code, principios SOLID, patrones de diseño, seguridad, rendimiento,
duplicación de código, complejidad ciclomática, buenas prácticas del lenguaje/framework y documentación.
Cada hallazgo debe explicar el POR QUÉ técnico, no solo describir el síntoma.
Usa los hallazgos de analizadores estáticos como evidencia para fundamentar tu razonamiento, no los repitas tal cual.
Responde EXCLUSIVAMENTE con un objeto JSON que cumpla este esquema, sin texto fuera del JSON:
{
  "findings": [{
    "category": "architecture|clean_code|solid|security|performance|duplication|complexity|best_practice|documentation|test_coverage",
    "severity": "info|low|medium|high|critical",
    "file_path": "string",
    "line_start": number|null,
    "line_end": number|null,
    "title": "string",
    "explanation": "string",
    "suggested_fix": {"type": "string", "diff": "string", "description": "string"}|null,
    "confidence": number entre 0 y 1
  }],
  "quality_score": number entre 0 y 100,
  "risk_level": "low|medium|high",
  "summary": "string"
}`;

export function buildSinglePassReviewPrompt(input: ReviewDiffInput) {
  const staticFindingsText = input.staticFindings.length
    ? input.staticFindings
        .map((f) => `- [${f.tool}/${f.ruleId}] ${f.filePath}:${f.line ?? '?'} ${f.message} (severity: ${f.severity})`)
        .join('\n')
    : '(sin hallazgos de analizadores estáticos)';

  const contextText = input.retrievedContext.length
    ? input.retrievedContext
        .map((c) => `--- ${c.filePath}${c.symbolName ? ` (${c.symbolName})` : ''} ---\n${c.content}`)
        .join('\n\n')
    : '(sin contexto adicional recuperado)';

  const profile = input.projectProfile;
  const hasProfile = profile && Object.values(profile).some((v) => v);
  const profileText = hasProfile
    ? [
        profile.language && `Lenguaje: ${profile.language}`,
        profile.framework && `Framework: ${profile.framework}`,
        profile.frameworkVersion && `Versión del framework: ${profile.frameworkVersion}`,
        profile.runtime && `Runtime: ${profile.runtime}`,
        profile.database && `Base de datos: ${profile.database}`,
        profile.architectureStyle && `Estilo de arquitectura: ${profile.architectureStyle}`,
        profile.testingStrategy && `Estrategia de testing: ${profile.testingStrategy}`,
        profile.notes && `Notas: ${profile.notes}`,
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  const userContent = [
    `Repositorio: ${input.repositoryFullName}`,
    `Commit: ${input.commitSha}`,
    ...(profileText
      ? [
          '',
          '## Perfil del proyecto declarado',
          'Calibra tus hallazgos y expectativas de convenciones contra este stack real — no',
          'apliques criterios genéricos ni de otro lenguaje/framework distinto al declarado.',
          profileText,
        ]
      : []),
    '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
    '',
    '## Hallazgos de analizadores estáticos (deterministas, úsalos como evidencia)',
    staticFindingsText,
    '',
    '## Contexto relacionado recuperado del repositorio',
    contextText,
  ].join('\n');

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userContent },
  ];
}
