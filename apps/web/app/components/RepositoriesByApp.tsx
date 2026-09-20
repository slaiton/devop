'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { RepoGlyphIcon, CheckIcon, CrossIcon, WarnTriangleIcon } from './icons';

export interface Repository {
  id: string;
  full_name: string;
  default_branch: string;
  webhook_status: string;
  account_login: string | null;
  github_app_id: string | null;
  github_app_name: string | null;
  last_commit_sha: string | null;
  last_branch: string | null;
  last_gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  last_risk_level: 'low' | 'medium' | 'high' | null;
  last_quality_score: number | null;
  last_activity_at: string | null;
}

const GATE_META: Record<string, { label: string; pill: string; Icon: typeof CheckIcon }> = {
  apto: { label: 'APTO', pill: 'ok', Icon: CheckIcon },
  requiere_revision: { label: 'REVISIÓN', pill: 'warn', Icon: WarnTriangleIcon },
  no_apto: { label: 'NO APTO', pill: 'bad', Icon: CrossIcon },
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'sin actividad';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} d`;
}

interface AppGroup {
  key: string;
  label: string;
  repositories: Repository[];
}

export function RepositoriesByApp({ repositories, emptyMessage }: { repositories: Repository[]; emptyMessage: string }) {
  const groups = useMemo<AppGroup[]>(() => {
    const byApp = new Map<string, AppGroup>();
    for (const repo of repositories) {
      const key = repo.github_app_id ?? 'sin-app';
      const label = repo.github_app_name ?? 'Sin GitHub App asociada';
      if (!byApp.has(key)) byApp.set(key, { key, label, repositories: [] });
      byApp.get(key)!.repositories.push(repo);
    }
    return [...byApp.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [repositories]);

  const [activeKey, setActiveKey] = useState<string | null>(groups[0]?.key ?? null);
  const activeGroup = groups.find((g) => g.key === activeKey) ?? groups[0] ?? null;

  if (repositories.length === 0) {
    return <p className="panel-empty">{emptyMessage}</p>;
  }

  return (
    <>
      {groups.length > 1 && (
        <nav className="repo-tabs" style={{ marginTop: 0 }}>
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`repo-tab${group.key === activeGroup?.key ? ' repo-tab-active' : ''}`}
              onClick={() => setActiveKey(group.key)}
            >
              {group.label} ({group.repositories.length})
            </button>
          ))}
        </nav>
      )}

      {activeGroup && (
        <div className="repo-list repo-tab-panel">
          {activeGroup.repositories.map((repo) => {
            const gate = repo.last_gate_decision ? GATE_META[repo.last_gate_decision] : null;
            const GateIcon = gate?.Icon;
            const [org, ...rest] = repo.full_name.split('/');
            return (
              <Link key={repo.id} href={`/repositories/${repo.id}`} className="repo-list-row" style={{ color: 'inherit' }}>
                <span className="repo-glyph">
                  <RepoGlyphIcon />
                </span>
                <div className="repo-list-main">
                  <div className="name">
                    <span className="org">{org}/</span>
                    {rest.join('/')}
                  </div>
                  <div className="meta">
                    {repo.last_branch ?? repo.default_branch}
                    {repo.last_commit_sha ? (
                      <>
                        {' · '}
                        <code>{repo.last_commit_sha.slice(0, 7)}</code>
                      </>
                    ) : null}
                    {' · '}
                    {timeAgo(repo.last_activity_at)}
                  </div>
                </div>
                {gate && GateIcon && (
                  <span className={`pill ${gate.pill}`}>
                    <GateIcon width={10} height={10} />
                    {gate.label}
                  </span>
                )}
                <span className="repo-score">{repo.last_quality_score != null ? `${repo.last_quality_score}/100` : '—'}</span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
