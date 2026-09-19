import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../../../../../session';
import { CommentForm } from './CommentForm';
import { SuggestReplyButton } from './SuggestReplyButton';
import { IssueStateButton } from './IssueStateButton';

interface IssueComment {
  id: string;
  author_login: string | null;
  body: string;
  source: 'github' | 'devsentinel';
  created_at: string;
  deleted_at: string | null;
}

interface IssueDetail {
  id: string;
  repository_id: string;
  repository_full_name: string;
  github_issue_number: number;
  kind: 'findings' | 'manual';
  origin: 'github' | 'devsentinel';
  title: string;
  body: string;
  state: 'open' | 'closed';
  author_login: string | null;
  first_commit_sha: string | null;
  last_commit_sha: string | null;
  resolved_commit_sha: string | null;
  resolved_via: 'push' | 'reconsideration' | null;
  ai_suggested_reply: string | null;
  ai_suggested_reply_status: 'pending' | 'ready' | 'failed' | null;
  ai_suggested_reply_error: string | null;
  comments: IssueComment[];
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

const SOURCE_LABEL: Record<string, string> = { github: 'GitHub', devsentinel: 'DevSentinel' };
const RESOLVED_VIA_LABEL: Record<string, string> = { push: 'un push nuevo', reconsideration: 'una reconsideración manual' };

function CommitLink({ repositoryFullName, sha }: { repositoryFullName: string; sha: string }) {
  return (
    <a href={`https://github.com/${repositoryFullName}/commit/${sha}`} target="_blank" rel="noreferrer">
      <code>{sha.slice(0, 7)}</code>
    </a>
  );
}

export default async function IssueDetailPage({ params }: { params: Promise<{ id: string; issueId: string }> }) {
  const session = await getSession();
  if (!session) {
    return <p>No autorizado.</p>;
  }

  const isAdmin = session.role === 'admin';
  const { id, issueId } = await params;

  let issue: IssueDetail;
  try {
    issue = await fetchJson<IssueDetail>(`/issues/${issueId}`);
  } catch {
    return (
      <>
        <p>
          <Link href={`/repositories/${id}/issues`}>&larr; Issues</Link>
        </p>
        <p>No tienes acceso a este issue.</p>
      </>
    );
  }

  const visibleComments = issue.comments.filter((c) => !c.deleted_at);

  return (
    <>
      <p>
        <Link href={`/repositories/${id}/issues`}>&larr; Issues</Link>
      </p>

      <h1>
        #{issue.github_issue_number} — {issue.title}
      </h1>
      <p>
        <span className={issue.state === 'open' ? 'status-ok' : 'status-bad'}>
          {issue.state === 'open' ? 'Abierto' : 'Cerrado'}
        </span>{' '}
        <span className="badge badge-low">{SOURCE_LABEL[issue.origin]}</span>
        {issue.author_login && ` — creado por ${issue.author_login}`}
      </p>

      {(issue.first_commit_sha || issue.resolved_commit_sha) && (
        <p style={{ color: 'var(--ink-muted)' }}>
          {issue.first_commit_sha && (
            <>
              Detectado en <CommitLink repositoryFullName={issue.repository_full_name} sha={issue.first_commit_sha} />
            </>
          )}
          {issue.last_commit_sha && issue.last_commit_sha !== issue.first_commit_sha && issue.state === 'open' && (
            <>
              {' '}
              — último análisis: <CommitLink repositoryFullName={issue.repository_full_name} sha={issue.last_commit_sha} />
            </>
          )}
          {issue.state === 'closed' && (
            <>
              {' '}
              — resuelto por{' '}
              {issue.resolved_commit_sha ? (
                <CommitLink repositoryFullName={issue.repository_full_name} sha={issue.resolved_commit_sha} />
              ) : (
                RESOLVED_VIA_LABEL[issue.resolved_via ?? ''] ?? 'una acción manual'
              )}
            </>
          )}
        </p>
      )}

      <div className="card">
        <p style={{ whiteSpace: 'pre-wrap' }}>{issue.body}</p>
      </div>

      {isAdmin && <IssueStateButton issueId={issue.id} state={issue.state} />}

      <h1>Comentarios</h1>
      {visibleComments.length === 0 ? (
        <p>Todavía no hay comentarios.</p>
      ) : (
        <ul>
          {visibleComments.map((c) => (
            <li key={c.id} className="card">
              <p>
                <strong>{c.author_login ?? (c.source === 'devsentinel' ? 'DevSentinel' : 'desconocido')}</strong>{' '}
                <span className="badge badge-low">{SOURCE_LABEL[c.source]}</span>{' '}
                <em>{new Date(c.created_at).toLocaleString()}</em>
              </p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <h1>Responder</h1>
          <CommentForm issueId={issue.id} />
          <SuggestReplyButton
            issueId={issue.id}
            status={issue.ai_suggested_reply_status}
            suggestedReply={issue.ai_suggested_reply}
            error={issue.ai_suggested_reply_error}
          />
        </>
      )}
    </>
  );
}
