import type { ReviewDiffInput } from './types';

const SYSTEM_PROMPT = `Eres un revisor de código senior actuando como arquitecto de software y gatekeeper de calidad antes de producción.

Analiza el commit proporcionado utilizando como contexto OBLIGATORIO la configuración específica del proyecto (lenguaje, framework, versión, runtime, base de datos, arquitectura, reglas obligatorias, reglas de seguridad, política de migraciones, compatibilidad, convenciones) que se te entrega más abajo. No apliques criterios genéricos ni de otro lenguaje/framework distinto al declarado.

Evalúa el commit y sus cambios (diff y archivos modificados) verificando estas 10 dimensiones:
1. Cumplimiento de la arquitectura y convenciones definidas para el proyecto.
2. Correcta separación de responsabilidades.
3. Uso adecuado del framework y tecnologías nativas.
4. Calidad, legibilidad y mantenibilidad del código.
5. Seguridad: validaciones, autorización, secretos, datos sensibles y vulnerabilidades evidentes.
6. Base de datos: queries, migraciones, índices y compatibilidad.
7. Compatibilidad con el código existente y posibles regresiones.
8. Manejo de errores y casos límite.
9. Cumplimiento de la estrategia de testing definida.
10. Riesgo del cambio para producción.

Utiliza también los últimos commits del proyecto (si se entregan) como contexto para detectar dependencias, regresiones o cambios relacionados — referencia esa comparación en "comparacion_commits_previos".

Cuando un hallazgo corresponda EXACTAMENTE a una regla obligatoria, de seguridad o convención declarada por el proyecto, cita el texto literal de esa regla en el campo "violated_rule" del hallazgo. Si el hallazgo es una observación general sin una regla declarada específica, deja "violated_rule" en null.

Reglas de bloqueo: lo determinista bloquea, tú explicas y recomiendas. Si detectas una violación crítica de seguridad, de arquitectura, de integridad de datos, o una posible regresión grave, márcala con severity="critical" y category="security"|"architecture"|"database"|"regression" según corresponda — el sistema aplicará el bloqueo automáticamente sin importar el score que asignes. No apruebes un commit únicamente porque funcione: debe cumplir las reglas específicas del proyecto y los requisitos mínimos para llegar a producción.

Basa el análisis ÚNICAMENTE en la evidencia disponible en el diff, los hallazgos de analizadores estáticos, el contexto recuperado del repositorio, el perfil del proyecto y el historial de commits entregados. No inventes información que no esté presente en ese contexto.

Responde EXCLUSIVAMENTE con un objeto JSON que cumpla este esquema, sin texto fuera del JSON:
{
  "resultado": "APTO|REQUIERE_REVISION|NO_APTO",
  "findings": [{
    "category": "architecture|clean_code|solid|security|performance|duplication|complexity|best_practice|documentation|test_coverage|database|regression",
    "severity": "info|low|medium|high|critical",
    "file_path": "string",
    "line_start": number|null,
    "line_end": number|null,
    "title": "string",
    "explanation": "string (el POR QUÉ técnico, no solo el síntoma)",
    "suggested_fix": {"type": "string", "diff": "string", "description": "string"}|null,
    "confidence": number entre 0 y 1,
    "violated_rule": "string con el texto literal de la regla del proyecto incumplida, o null"
  }],
  "quality_score": number entre 0 y 100,
  "risk_level": "low|medium|high",
  "resumen_ejecutivo": "string",
  "recomendaciones": ["string"],
  "tests_recomendados": ["string (tests recomendados o faltantes)"],
  "comparacion_commits_previos": "string (relación relevante con los últimos commits, o 'sin relación relevante' si no aplica)",
  "justificacion_final": "string (por qué el resultado es el que es)"
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
  const hasProfile = profile && Object.values(profile).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));

  const ruleList = (label: string, rules: string[] | undefined) =>
    rules && rules.length ? [`${label}:`, ...rules.map((r) => `  - ${r}`)].join('\n') : null;

  const profileText = hasProfile
    ? [
        profile.language && `Lenguaje: ${profile.language}`,
        profile.framework && `Framework: ${profile.framework}`,
        profile.frameworkVersion && `Versión del framework: ${profile.frameworkVersion}`,
        profile.runtime && `Runtime: ${profile.runtime}`,
        profile.database && `Base de datos: ${profile.database}`,
        profile.architectureStyle && `Arquitectura: ${profile.architectureStyle}`,
        profile.testingStrategy && `Estrategia de testing: ${profile.testingStrategy}`,
        profile.migrationsPolicy && `Política de migraciones: ${profile.migrationsPolicy}`,
        profile.compatibilityNotes && `Compatibilidad: ${profile.compatibilityNotes}`,
        ruleList('Reglas obligatorias (checklist, cita el texto exacto si se incumple)', profile.mandatoryRules),
        ruleList('Reglas de seguridad (checklist, cita el texto exacto si se incumple)', profile.securityRules),
        ruleList('Convenciones (checklist, cita el texto exacto si se incumple)', profile.conventions),
        profile.notes && `Notas: ${profile.notes}`,
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  const recentCommitsText =
    input.recentCommits && input.recentCommits.length
      ? input.recentCommits.map((c) => `- ${c.sha.slice(0, 7)} (${c.author ?? '?'}, ${c.date ?? '?'}): ${c.message}`).join('\n')
      : '(sin historial de commits previos disponible)';

  const userContent = [
    `Repositorio: ${input.repositoryFullName}`,
    `Commit: ${input.commitSha}`,
    `Archivos modificados en este commit: ${input.analyzedFiles.length ? input.analyzedFiles.join(', ') : '(no se pudo determinar)'}`,
    ...(profileText
      ? [
          '',
          '## Configuración específica del proyecto (contexto obligatorio)',
          'Calibra tus hallazgos y expectativas de convenciones contra este stack real.',
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
    '',
    '## Últimos commits del proyecto (para detectar dependencias/regresiones relacionadas)',
    recentCommitsText,
  ].join('\n');

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userContent },
  ];
}
