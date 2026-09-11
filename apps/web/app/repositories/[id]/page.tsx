import { cookies } from 'next/headers';
import Link from 'next/link';
import { RepoSettingsForm } from './RepoSettingsForm';
import { NotifyButton } from './NotifyButton';
import { ProjectProfileForm } from './ProjectProfileForm';
import { CreatePullRequestButton, MergePullRequestButton } from './PullRequestActions';
import { MarkReviewedButton } from './MarkReviewedButton';
import { GateBadge } from '../../GateBadge';
import { getSession } from '../../session';

interface PushRow {
  id: string;
  commit_sha: string;
  branch: string | null;
  status: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  blocking_count: number;
  author_name: string | null;
  author_email: string | null;
  notified_at: string | null;
  reviewed_at: string | null;
  started_at: string;
}

interface RepoSettings {
  promotion_source_branch: string;
  promotion_target_branch: string;
  auto_create_pr_on_push: boolean;
}

interface PullRequestRow {
  id: string;
  github_pr_number: number;
  title: string;
  author_login: string;
  source_branch: string;
  target_branch: string;
  status: 'open' | 'merged' | 'closed';
  created_by: 'github' | 'devsentinel';
  source_review_run_id: string | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
}

interface ProjectProfileRow {
  language: string | null;
  framework: string | null;
  framework_version: string | null;
  runtime: string | null;
  database: string | null;
  architecture_style: string | null;
  testing_strategy: string | null;
  notes: string | null;
  mandatory_rules: string[];
  security_rules: string[];
  conventions: string[];
  migrations_policy: string | null;
  compatibility_notes: string | null;
}

function isEligibleForPullRequest(run: Pick<PushRow, 'gate_decision' | 'risk_level' | 'quality_score'>): boolean {
  if (run.gate_decision === 'no_apto') return false;
  return run.gate_decision === 'apto' || (run.risk_level === 'medium' && (run.quality_score ?? 100) <= 70);
}

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export default async function RepositoryPullRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return (
      <main>
        <p>No autorizado.</p>
      </main>
    );
  }

  const { id } = await params;
  const [pushes, settings, projectProfile, pullRequests] = await Promise.all([
    fetchJson<PushRow[]>(`/dashboard/repositories/${id}/pushes`),
    fetchJson<RepoSettings>(`/dashboard/repositories/${id}/settings`),
    fetchJson<ProjectProfileRow>(`/dashboard/repositories/${id}/project-profile`),
    fetchJson<PullRequestRow[]>(`/pull-requests/repository/${id}`),
  ]);

  const reviewRunsWithPr = new Set(pullRequests.map((pr) => pr.source_review_run_id).filter(Boolean));

  return (
    <main>
      <p>
        <Link href="/">&larr; Repositorios</Link>
      </p>

      <h1>Pull requests</h1>
      {pullRequests.length === 0 ? (
        <p>Todavía no hay Pull Requests para este repositorio.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Título</th>
              <th>Autor</th>
              <th>Rama</th>
              <th>Origen</th>
              <th>Score</th>
              <th>Riesgo</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {pullRequests.map((pr) => (
              <tr key={pr.id}>
                <td>{pr.github_pr_number}</td>
                <td>
                  {pr.source_review_run_id ? <Link href={`/review-runs/${pr.source_review_run_id}`}>{pr.title}</Link> : pr.title}
                </td>
                <td>{pr.author_login}</td>
                <td>{pr.source_branch} → {pr.target_branch}</td>
                <td>{pr.created_by === 'devsentinel' ? 'DevSentinel' : 'GitHub'}</td>
                <td>{pr.quality_score ?? '-'}</td>
                <td>{pr.risk_level ? <span className={`badge badge-${pr.risk_level}`}>{pr.risk_level}</span> : '-'}</td>
                <td>{pr.status === 'open' ? <GateBadge decision={pr.gate_decision} /> : pr.status}</td>
                <td>{pr.status === 'open' && <MergePullRequestButton pullRequestId={pr.id} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h1>Pushes</h1>
      {pushes.length === 0 ? (
        <p>Todavía no hay pushes analizados en las ramas monitoreadas.</p>
      ) : (
        <div>
          {pushes.map((run) => (
            <div key={run.id} className="card">
              <p>
                <strong>{run.branch ?? '-'}</strong> — commit{' '}
                <Link href={`/review-runs/${run.id}`}>{run.commit_sha.slice(0, 7)}</Link> —{' '}
                {new Date(run.started_at).toLocaleString()}
              </p>
              <p>
                {run.status !== 'completed' ? (
                  <span>Estado: {run.status}</span>
                ) : (
                  <>
                    <GateBadge decision={run.gate_decision} />
                    {run.gate_decision === 'no_apto' && ` — ${run.blocking_count} hallazgo(s) bloqueante(s)`}
                  </>
                )}
                {' — '}
                Score: {run.quality_score ?? '-'} — Riesgo:{' '}
                {run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}
              </p>
              {run.notified_at && <p>✉️ Notificado el {new Date(run.notified_at).toLocaleString()}</p>}
              {run.reviewed_at ? (
                <p className="status-ok">✓ Revisado el {new Date(run.reviewed_at).toLocaleString()}</p>
              ) : (
                <div className="card-row">
                  {run.author_email && !run.notified_at && (
                    <NotifyButton repositoryId={id} reviewRunId={run.id} authorEmail={run.author_email} />
                  )}
                  {isEligibleForPullRequest(run) && !reviewRunsWithPr.has(run.id) && (
                    <CreatePullRequestButton repositoryId={id} reviewRunId={run.id} />
                  )}
                  <MarkReviewedButton repositoryId={id} reviewRunId={run.id} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h1>Perfil del proyecto</h1>
      <ProjectProfileForm
        repositoryId={id}
        initial={{
          language: projectProfile.language ?? '',
          framework: projectProfile.framework ?? '',
          frameworkVersion: projectProfile.framework_version ?? '',
          runtime: projectProfile.runtime ?? '',
          database: projectProfile.database ?? '',
          architectureStyle: projectProfile.architecture_style ?? '',
          testingStrategy: projectProfile.testing_strategy ?? '',
          migrationsPolicy: projectProfile.migrations_policy ?? '',
          compatibilityNotes: projectProfile.compatibility_notes ?? '',
          notes: projectProfile.notes ?? '',
          mandatoryRules: (projectProfile.mandatory_rules ?? []).join('\n'),
          securityRules: (projectProfile.security_rules ?? []).join('\n'),
          conventions: (projectProfile.conventions ?? []).join('\n'),
        }}
      />

      <h1>Configuración</h1>
      <RepoSettingsForm
        repositoryId={id}
        promotionSourceBranch={settings.promotion_source_branch}
        promotionTargetBranch={settings.promotion_target_branch}
        autoCreatePrOnPush={settings.auto_create_pr_on_push}
      />
    </main>
  );
}
