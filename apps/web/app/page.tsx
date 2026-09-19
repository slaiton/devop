import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from './session';
import { AppShell } from './components/AppShell';
import { LoginForm } from './components/LoginForm';
import { RepoGlyphIcon, ShieldIcon, CheckIcon, CrossIcon, WarnTriangleIcon } from './components/icons';

interface Repository {
  id: string;
  full_name: string;
  default_branch: string;
  webhook_status: string;
  last_commit_sha: string | null;
  last_branch: string | null;
  last_gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  last_risk_level: 'low' | 'medium' | 'high' | null;
  last_quality_score: number | null;
  last_activity_at: string | null;
}

interface DeveloperRow {
  id: string;
  github_login: string | null;
  email: string | null;
  display_name: string | null;
  total_reviews: string;
  avg_quality_score: number | null;
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

async function fetchSetupStatus(): Promise<{ configured: boolean }> {
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/users/bootstrap-status`, { cache: 'no-store' });
  if (!res.ok) return { configured: true }; // ante la duda, no invitar a re-configurar
  return res.json();
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

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

const AVATAR_GRADIENTS = [
  'linear-gradient(155deg,#5b7fff,#8a6cff)',
  'linear-gradient(155deg,#3dd68c,#1fa9c7)',
  'linear-gradient(155deg,#f5a524,#ff5d6c)',
  'linear-gradient(155deg,#8891a6,#5b6376)',
];

export default async function HomePage() {
  const session = await getSession();

  if (!session) {
    const { configured } = await fetchSetupStatus();
    if (!configured) {
      return (
        <div className="login-screen">
          <div className="login-grid-bg" />
          <div className="login-card">
            <div className="brand-mark">
              <ShieldIcon />
            </div>
            <h1>DevSentinel AI</h1>
            <p className="tagline">Este despliegue todavía no tiene una organización configurada.</p>
            <Link href="/setup" className="btn-primary">
              Configurar DevSentinel AI
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="login-screen">
        <div className="login-grid-bg" />
        <div className="login-card">
          <div className="brand-mark">
            <ShieldIcon />
          </div>
          <h1>DevSentinel AI</h1>
          <p className="tagline">
            Revisión de código con IA y gestión de Git sin fricción.
            <br />
            Iniciá sesión con tu correo y contraseña para continuar.
          </p>

          <LoginForm />

          <p className="login-fine">
            ¿Problemas para entrar? Pedile a un administrador que te registre desde Usuarios.
          </p>
        </div>
      </div>
    );
  }

  const isAdmin = session.role === 'admin';
  const [repositories, developers] = await Promise.all([
    fetchJson<Repository[]>('/dashboard/repositories'),
    isAdmin ? fetchJson<DeveloperRow[]>('/dashboard/developers').catch(() => []) : Promise.resolve([]),
  ]);

  const needingAttention = repositories.filter(
    (r) => r.last_gate_decision === 'no_apto' || r.last_gate_decision === 'requiere_revision',
  ).length;
  const scored = repositories.filter((r) => r.last_quality_score != null);
  const avgScore = scored.length
    ? Math.round(scored.reduce((sum, r) => sum + (r.last_quality_score ?? 0), 0) / scored.length)
    : null;

  const topDevelopers = [...developers]
    .sort((a, b) => Number(b.total_reviews) - Number(a.total_reviews))
    .slice(0, 6);
  const maxReviews = Math.max(1, ...topDevelopers.map((d) => Number(d.total_reviews)));

  return (
    <AppShell session={session}>
      <div className="page-head">
        <div>
          <h1>Repositorios</h1>
          <p>
            {repositories.length} repositorio{repositories.length === 1 ? '' : 's'}
            {isAdmin ? ' conectados' : ' asignados'}
            {needingAttention > 0 ? ` — ${needingAttention} necesitan atención` : ''}.
          </p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-tile">
          <div className="label">Repositorios</div>
          <div className="value">{repositories.length}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Necesitan atención</div>
          <div className="value" style={{ color: needingAttention > 0 ? 'var(--danger)' : 'var(--ink)' }}>
            {needingAttention}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Score promedio</div>
          <div className="value">{avgScore ?? '—'}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Rol</div>
          <div className="value" style={{ fontSize: '1.1rem' }}>
            {isAdmin ? 'Admin' : 'Usuario'}
          </div>
        </div>
      </div>

      <div className={isAdmin ? 'dash-grid' : ''} style={!isAdmin ? { marginTop: '1.1rem' } : undefined}>
        <div className="panel">
          <div className="panel-head">
            <h2>Repositorios y última actividad</h2>
          </div>
          {repositories.length === 0 ? (
            <p className="panel-empty">
              {isAdmin
                ? 'Todavía no hay repositorios conectados. Instalá la GitHub App en tu organización para empezar.'
                : 'Todavía no tenés repositorios asignados. Pedile a un admin que te dé acceso desde Usuarios.'}
            </p>
          ) : (
            <div className="repo-list">
              {repositories.map((repo) => {
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
        </div>

        {isAdmin && (
          <div className="panel">
            <div className="panel-head">
              <h2>Top developers</h2>
              <Link href="/developers" className="see-all">
                Ver todos →
              </Link>
            </div>
            {topDevelopers.length === 0 ? (
              <p className="panel-empty">Todavía no hay actividad registrada por developer.</p>
            ) : (
              <div className="dev-list">
                {topDevelopers.map((dev, i) => {
                  const label = dev.display_name ?? dev.github_login ?? dev.email ?? 'Sin nombre';
                  const reviews = Number(dev.total_reviews);
                  return (
                    <div key={dev.id} className="dev-row">
                      <span className="dev-rank">{i + 1}</span>
                      <span className="dev-avatar" style={{ background: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length] }}>
                        {initialsOf(label)}
                      </span>
                      <div className="dev-main">
                        <div className="name">{label}</div>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${Math.max(6, (reviews / maxReviews) * 100)}%` }} />
                        </div>
                      </div>
                      <span className="dev-count">{reviews}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
