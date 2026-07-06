import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import type { StaticAnalysisFinding } from '@devsentinel/llm-port';
import { SandboxRunnerService } from './sandboxRunner.service';

@Injectable()
export class StaticAnalysisService {
  constructor(private readonly sandbox: SandboxRunnerService) {}

  async run(checkoutPath: string): Promise<StaticAnalysisFinding[]> {
    const [semgrepFindings, gitleaksFindings] = await Promise.all([
      this.runSemgrep(checkoutPath),
      this.runGitleaks(checkoutPath),
    ]);
    return [...semgrepFindings, ...gitleaksFindings];
  }

  private async runSemgrep(checkoutPath: string): Promise<StaticAnalysisFinding[]> {
    const result = await this.sandbox.run({
      image: 'semgrep/semgrep:latest',
      cmd: ['semgrep', 'scan', '--config=auto', '--json', '--quiet', checkoutPath],
      workdir: checkoutPath,
      timeoutMs: 120_000,
      networkDisabled: false,
    });

    try {
      const parsed = JSON.parse(result.stdout || '{}');
      return (parsed.results ?? []).map((r: any) => ({
        tool: 'semgrep' as const,
        ruleId: r.check_id,
        filePath: r.path,
        line: r.start?.line,
        message: r.extra?.message ?? r.check_id,
        severity: r.extra?.severity ?? 'WARNING',
      }));
    } catch {
      return [];
    }
  }

  private async runGitleaks(checkoutPath: string): Promise<StaticAnalysisFinding[]> {
    const reportPath = `${checkoutPath}/.gitleaks-report.json`;
    await this.sandbox.run({
      image: 'zricethezav/gitleaks:latest',
      cmd: [
        'detect',
        '--no-git',
        '--source',
        checkoutPath,
        '--report-format',
        'json',
        '--report-path',
        reportPath,
        '--exit-code',
        '0',
      ],
      workdir: checkoutPath,
      timeoutMs: 60_000,
      networkDisabled: true,
    });

    try {
      const raw = await readFile(reportPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return (parsed ?? []).map((r: any) => ({
        tool: 'gitleaks' as const,
        ruleId: r.RuleID,
        filePath: r.File,
        line: r.StartLine,
        message: `Posible secreto expuesto (${r.RuleID})`,
        severity: 'critical',
      }));
    } catch {
      return [];
    }
  }
}
