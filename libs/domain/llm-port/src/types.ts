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
});

export const reviewResultSchema = z.object({
  findings: z.array(findingSchema),
  quality_score: z.number().int().min(0).max(100),
  risk_level: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
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
}

export interface ReviewDiffInput {
  repositoryFullName: string;
  commitSha: string;
  diff: string;
  staticFindings: StaticAnalysisFinding[];
  retrievedContext: RetrievedContextChunk[];
  projectProfile?: ProjectProfile;
}
