import type { TriageResult } from '@devsentinel/llm-port';
import type { NormalizedFinding } from '../types';
import type { ChangeTagResult } from './changeProfile';
import type { ValidatedTriage } from './validate';

/** ¿Este cambio necesita la auditoría avanzada (capa 3)? Lo decide la APLICACIÓN con reglas reproducibles; la recomendación del
 * modelo es un disparador más, no la decisión. Cada disparador queda registrado con su motivo. */

export interface EscalationTrigger {
  type: 'model_recommendation' | 'sensitive_change' | 'serious_finding' | 'high_risk' | 'conflict';
  detail: string;
}

export interface EscalationResult {
  recommended: boolean;
  triggers: EscalationTrigger[];
}

export interface EscalationConfig {
  /** Tipos de cambio que escalan siempre que aparezcan (por defecto: auth, iam, ci_cd, migration, payments). */
  sensitiveTags: string[];
}

export function escalationConfigFromEnv(): EscalationConfig {
  const raw = process.env.AUDIT_ESCALATION_TAGS;
  return { sensitiveTags: (raw ? raw.split(',') : ['auth', 'iam', 'ci_cd', 'migration', 'payments']).map((s) => s.trim()).filter(Boolean) };
}

export function evaluateEscalation(params: {
  triage: TriageResult;
  validated: ValidatedTriage;
  changeTags: ChangeTagResult[];
  layer1Findings: NormalizedFinding[];
  config: EscalationConfig;
}): EscalationResult {
  const { triage, validated, changeTags, layer1Findings, config } = params;
  const triggers: EscalationTrigger[] = [];

  if (triage.escalation.recommended || triage.findings.some((f) => f.needs_layer3)) {
    const reasons = [...triage.escalation.reasons, ...triage.findings.filter((f) => f.needs_layer3 && f.escalation_reason).map((f) => f.escalation_reason!)];
    triggers.push({ type: 'model_recommendation', detail: reasons.length ? [...new Set(reasons)].slice(0, 4).join(' · ') : 'el modelo recomienda una revisión avanzada' });
  }

  for (const t of changeTags) {
    if (config.sensitiveTags.includes(t.tag)) triggers.push({ type: 'sensitive_change', detail: `${t.tag}: ${t.files.slice(0, 3).join(', ')}${t.files.length > 3 ? '…' : ''}` });
  }

  const seriousScanner = layer1Findings.filter(
    (f) => (f.severity === 'critical' || f.severity === 'high') && f.baseline !== 'preexisting' && f.validation === 'confirmed' && f.category !== 'secret',
  );
  const seriousOwn = validated.findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && f.validation_status === 'confirmed');
  if (seriousScanner.length + seriousOwn.length > 0) {
    triggers.push({ type: 'serious_finding', detail: `${seriousScanner.length + seriousOwn.length} hallazgo(s) grave(s) confirmado(s) en este cambio` });
  }

  if (triage.risk_level === 'high') triggers.push({ type: 'high_risk', detail: 'el triaje estima riesgo alto' });
  if (validated.conflicts.length > 0) triggers.push({ type: 'conflict', detail: validated.conflicts.slice(0, 3).join(' · ') });

  return { recommended: triggers.length > 0, triggers };
}
