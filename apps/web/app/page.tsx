import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from './session';
import { AppShell } from './components/AppShell';
import { LoginForm } from './components/LoginForm';
import { RepositoriesByApp, type Repository } from './components/RepositoriesByApp';
import { ShieldIcon } from './components/icons';

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
          <RepositoriesByApp
            repositories={repositories}
            emptyMessage={
              isAdmin
                ? 'Todavía no hay repositorios conectados. Conectá una cuenta desde /accounts para empezar.'
                : 'Todavía no tenés repositorios asignados. Pedile a un admin que te dé acceso desde Usuarios.'
            }
          />
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
