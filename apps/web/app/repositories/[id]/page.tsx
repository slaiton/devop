import { cookies } from 'next/headers';
import Link from 'next/link';
import { MergeButton } from './MergeButton';
import { RequestPromotionButton, PromotionDecisionButtons } from './PromotionActions';
import { RepoSettingsForm } from './RepoSettingsForm';
import { NotifyButton } from './NotifyButton';
import { ProjectProfileForm } from './ProjectProfileForm';

interface PullRequestRow {
  id: string;
  github_pr_number: number;
  title: string;
  status: 'open' | 'merged' | 'closed';
  author_login: string;
  source_branch: string;
  target_branch: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  review_status: string | null;
}

interface PushRow {
  id: string;
  commit_sha: string;
  branch: string | null;
  status: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  gate_decision: 'apto' | 'no_apto' | null;
  blocking_count: number;
  promotion_id: string | null;
  promotion_status: string | null;
  author_name: string | null;
  author_email: string | null;
  notified_at: string | null;
  started_at: string;
}

interface PromotionRow {
  id: string;
  source_branch: string;
  target_branch: string;
  commit_sha: string;
  status: 'pending' | 'approved' | 'rejected';
  notes: string | null;
  requested_at: string;
  decided_at: string | null;
}

interface RepoSettings {
  monitored_branches: string[];
  promotion_source_branch: string;
  promotion_target_branch: string;
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
  const { id } = await params;
  const [pullRequests, pushes, promotions, settings, projectProfile] = await Promise.all([
    fetchJson<PullRequestRow[]>(`/dashboard/repositories/${id}/pull-requests`),
    fetchJson<PushRow[]>(`/dashboard/repositories/${id}/pushes`),
    fetchJson<PromotionRow[]>(`/dashboard/repositories/${id}/promotions`),
    fetchJson<RepoSettings>(`/dashboard/repositories/${id}/settings`),
    fetchJson<ProjectProfileRow>(`/dashboard/repositories/${id}/project-profile`),
  ]);

  const pendingPromotions = promotions.filter((p) => p.status === 'pending');

  return (
    <main>
      <p>
        <Link href="/">&larr; Repositorios</Link>
      </p>

      <h1>Pull requests</h1>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Título</th>
            <th>Autor</th>
            <th>Rama</th>
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
              <td>{pr.title}</td>
              <td>{pr.author_login}</td>
              <td>{pr.source_branch} → {pr.target_branch}</td>
              <td>{pr.quality_score ?? '-'}</td>
              <td>{pr.risk_level ? <span className={`badge badge-${pr.risk_level}`}>{pr.risk_level}</span> : '-'}</td>
              <td>{pr.status === 'open' ? (pr.review_status ?? 'pendiente') : pr.status}</td>
              <td>
                {pr.status === 'open' && (
                  <MergeButton
                    repositoryId={id}
                    pullRequestId={pr.id}
                    prNumber={pr.github_pr_number}
                    riskLevel={pr.risk_level}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h1>Promociones pendientes</h1>
      {pendingPromotions.length === 0 ? (
        <p>No hay promociones pendientes de aprobación.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Commit</th>
              <th>Rama</th>
              <th>Solicitada</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {pendingPromotions.map((p) => (
              <tr key={p.id}>
                <td>{p.commit_sha.slice(0, 7)}</td>
                <td>{p.source_branch} → {p.target_branch}</td>
                <td>{new Date(p.requested_at).toLocaleString()}</td>
                <td>
                  <PromotionDecisionButtons
                    promotionId={p.id}
                    sourceBranch={p.source_branch}
                    targetBranch={p.target_branch}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h1>Pushes</h1>
      {pushes.length === 0 ? (
        <p>Todavía no hay pushes analizados en las ramas monitoreadas.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {pushes.map((run) => {
            const canPromote =
              run.status === 'completed' &&
              run.gate_decision === 'apto' &&
              run.branch === settings.promotion_source_branch &&
              !run.promotion_id;

            return (
              <div key={run.id} style={{ border: '1px solid #ccc', borderRadius: 6, padding: '0.75rem' }}>
                <p>
                  <strong>{run.branch ?? '-'}</strong> — commit {run.commit_sha.slice(0, 7)} —{' '}
                  {new Date(run.started_at).toLocaleString()}
                </p>
                <p>
                  {run.status !== 'completed' ? (
                    <span>Estado: {run.status}</span>
                  ) : run.gate_decision === 'apto' ? (
                    <span style={{ color: 'green' }}>✓ APTO</span>
                  ) : (
                    <span style={{ color: 'crimson' }}>❌ NO APTO — {run.blocking_count} hallazgo(s) bloqueante(s)</span>
                  )}
                  {' — '}
                  Score: {run.quality_score ?? '-'} — Riesgo:{' '}
                  {run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}
                </p>
                {run.promotion_id && <p>Promoción: {run.promotion_status}</p>}
                {run.notified_at && <p>✉️ Notificado el {new Date(run.notified_at).toLocaleString()}</p>}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {run.author_email && !run.notified_at && (
                    <NotifyButton repositoryId={id} reviewRunId={run.id} authorEmail={run.author_email} />
                  )}
                  {canPromote && (
                    <RequestPromotionButton
                      repositoryId={id}
                      reviewRunId={run.id}
                      targetBranch={settings.promotion_target_branch}
                    />
                  )}
                </div>
              </div>
            );
          })}
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
          notes: projectProfile.notes ?? '',
        }}
      />

      <h1>Configuración</h1>
      <RepoSettingsForm
        repositoryId={id}
        monitoredBranches={settings.monitored_branches}
        promotionSourceBranch={settings.promotion_source_branch}
        promotionTargetBranch={settings.promotion_target_branch}
      />
    </main>
  );
}
