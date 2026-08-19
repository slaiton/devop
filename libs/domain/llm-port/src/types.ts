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
}
