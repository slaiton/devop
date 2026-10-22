import { z } from 'zod';

export const findingCategorySchema = z.enum([
  'architecture',
  'clean_code',
  'solid',
  'security',
  'performance',
  'duplication',
  'complexity',
  'best_practice',
  'documentation',
  'test_coverage',
  'database',
  'regression',
]);

export const findingSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export const findingSchema = z.object({
  category: findingCategorySchema,
  severity: findingSeveritySchema,
  file_path: z.string(),
  line_start: z.number().int().nullable().optional(),
  line_end: z.number().int().nullable().optional(),
  title: z.string(),
  explanation: z.string(),
  suggested_fix: z
    .object({
      type: z.string(),
      diff: z.string().optional(),
      description: z.string().optional(),
    })
    .nullable()
    .optional(),
  confidence: z.number().min(0).max(1),
  violated_rule: z.string().nullable().optional(),
});

export const reviewResultSchema = z.object({
  resultado: z.enum(['APTO', 'REQUIERE_REVISION', 'NO_APTO']),
  findings: z.array(findingSchema),
  quality_score: z.number().int().min(0).max(100),
  risk_level: z.enum(['low', 'medium', 'high']),
  resumen_ejecutivo: z.string(),
  recomendaciones: z.array(z.string()),
  tests_recomendados: z.array(z.string()),
  comparacion_commits_previos: z.string(),
  justificacion_final: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export interface StaticAnalysisFinding {
  tool: 'semgrep' | 'gitleaks';
  ruleId: string;
  filePath: string;
  line?: number;
  message: string;
  severity: string;
}

export interface RetrievedContextChunk {
  filePath: string;
  symbolName?: string;
  content: string;
}

export interface ProjectProfile {
  language?: string | null;
  framework?: string | null;
  frameworkVersion?: string | null;
  runtime?: string | null;
  database?: string | null;
  architectureStyle?: string | null;
  testingStrategy?: string | null;
  notes?: string | null;
  mandatoryRules?: string[];
  securityRules?: string[];
  conventions?: string[];
  migrationsPolicy?: string | null;
  compatibilityNotes?: string | null;
}

export const projectProfileExtractionSchema = z.object({
  language: z.string().nullable().optional(),
  framework: z.string().nullable().optional(),
  framework_version: z.string().nullable().optional(),
  runtime: z.string().nullable().optional(),
  database: z.string().nullable().optional(),
  architecture_style: z.string().nullable().optional(),
  testing_strategy: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  mandatory_rules: z.array(z.string()).nullable().optional(),
  security_rules: z.array(z.string()).nullable().optional(),
  conventions: z.array(z.string()).nullable().optional(),
  migrations_policy: z.string().nullable().optional(),
  compatibility_notes: z.string().nullable().optional(),
});

export type ProjectProfileExtraction = z.infer<typeof projectProfileExtractionSchema>;

export interface ContextDocument {
  path: string;
  content: string;
}

export interface ExtractProjectProfileInput {
  repositoryFullName: string;
  documents: ContextDocument[];
}

export interface RecentCommit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface ReviewDiffInput {
  repositoryFullName: string;
  commitSha: string;
  diff: string;
  staticFindings: StaticAnalysisFinding[];
  retrievedContext: RetrievedContextChunk[];
  projectProfile?: ProjectProfile;
  recentCommits?: RecentCommit[];
  analyzedFiles: string[];
  /** Solo análisis profundo. */
  deepContext?: DeepReviewContext;
}

export const reconsiderFindingResultSchema = z.object({
  status: z.enum(['open', 'fixed', 'dismissed_false_positive']),
  explanation: z.string(),
  updated_quality_score: z.number().int().min(0).max(100),
  updated_risk_level: z.enum(['low', 'medium', 'high']),
  justification: z.string(),
});

export type ReconsiderFindingResult = z.infer<typeof reconsiderFindingResultSchema>;

export interface ReconsiderFindingInput {
  repositoryFullName: string;
  commitSha: string;
  diff: string;
  finding: Finding;
  humanComment: string;
  currentQualityScore: number;
  currentRiskLevel: 'low' | 'medium' | 'high';
}

export const issueReplySuggestionResultSchema = z.object({
  reply: z.string(),
});

export type IssueReplySuggestionResult = z.infer<typeof issueReplySuggestionResultSchema>;

export interface IssueReplyComment {
  authorLogin: string | null;
  body: string;
  source: 'github' | 'devsentinel';
}

export interface IssueReplySuggestionInput {
  repositoryFullName: string;
  issueTitle: string;
  issueBody: string;
  comments: IssueReplyComment[];
  blockingFindings: Finding[];
}

// ---------------------------------------------------------------------------------------------
// Análisis profundo: el revisor puede llamar herramientas de solo lectura sobre el repo.
// ---------------------------------------------------------------------------------------------

/** Contexto que el worker arma sin gastar tokens antes de la investigación (solo modo profundo). */
export interface DeepReviewContext {
  /** Título/descripción/comentarios del Pull Request relacionado, si lo hay. */
  pullRequest?: string;
  /** Últimos commits de cada archivo modificado (por qué está como está). */
  fileHistory?: string;
  /** Dónde más se usan los símbolos (funciones, clases…) que el diff agrega o modifica. */
  symbolUsages?: string;
  /** Aviso si el diff se recortó para caber en el prompt. */
  truncatedNote?: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema del objeto de argumentos. */
  parameters: Record<string, unknown>;
}

export interface AgentToolResult {
  /** Texto que se le devuelve al modelo (ya acotado en tamaño). */
  output: string;
  /** Línea corta para la traza que ve el usuario ("12 coincidencias en 4 archivos"). */
  summary: string;
  ok: boolean;
}

export interface AgentToolbox {
  definitions: AgentToolDefinition[];
  /** Ejecuta una herramienta. Nunca debe lanzar: los errores se devuelven como `ok: false`. */
  execute(name: string, args: Record<string, unknown>): Promise<AgentToolResult>;
}

export interface AgenticReviewOptions {
  maxRounds: number;
  maxToolCalls: number;
  /** Tope de caracteres que las herramientas pueden devolver en total durante la revisión. */
  maxToolChars: number;
  /** Tiempo máximo de toda la investigación; al agotarse se pide el veredicto con lo reunido. */
  deadlineMs: number;
}

export interface ToolTraceEntry {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  chars: number;
  ms: number;
}

export interface AgenticReviewStats {
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** true si se cortó la investigación por presupuesto (rondas, consultas, tamaño o tiempo). */
  budgetExhausted: boolean;
}

export interface AgenticReviewOutcome {
  result: ReviewResult;
  trace: ToolTraceEntry[];
  stats: AgenticReviewStats;
}

/** El proveedor/modelo configurado no acepta herramientas (function calling): el llamador debe
 * caer al análisis estándar en vez de fallar la revisión. */
export class AgenticReviewUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticReviewUnsupportedError';
  }
}
