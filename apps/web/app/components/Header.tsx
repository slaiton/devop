'use client';

import { usePathname } from 'next/navigation';

interface HeaderProps {
  name: string | null;
  avatarUrl: string | null;
  role: string | null;
}

const LABELS: { prefix: string; label: string; exact?: boolean }[] = [
  { prefix: '/', label: 'Repositorios', exact: true },
  { prefix: '/overview', label: 'Pendientes' },
  { prefix: '/developers', label: 'Developers' },
  { prefix: '/users', label: 'Usuarios' },
  { prefix: '/accounts', label: 'Cuentas de GitHub' },
  { prefix: '/settings', label: 'Configuración del sistema' },
  { prefix: '/me', label: 'Mi perfil' },
  { prefix: '/repositories', label: 'Repositorio' },
  { prefix: '/review-runs', label: 'Análisis de commit' },
];

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function currentLabel(pathname: string | null): string {
  if (!pathname) return 'DevSentinel AI';
  const match = LABELS.find((l) => (l.exact ? pathname === l.prefix : pathname.startsWith(l.prefix)));
  return match?.label ?? 'DevSentinel AI';
}

export function Header({ name, avatarUrl, role }: HeaderProps) {
  const pathname = usePathname();

  return (
    <header className="app-header">
      <div className="breadcrumb">
        <strong>{currentLabel(pathname)}</strong>
      </div>
      <div className="header-right">
        <div className="user-chip">
          <span className="avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : initials(name)}</span>
          <div>
            <div className="who">{name ?? 'Sin nombre'}</div>
            <div className="role">{role === 'admin' ? 'Admin' : 'Usuario'}</div>
          </div>
        </div>
        <a className="logout-link" href="/api/auth/logout">
          Salir
        </a>
      </div>
    </header>
  );
}
