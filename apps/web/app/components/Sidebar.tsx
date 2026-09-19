'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AccountsIcon,
  DevelopersIcon,
  PendingIcon,
  RepositoriesIcon,
  SettingsIcon,
  ShieldIcon,
  UsersIcon,
} from './icons';

interface NavLink {
  href: string;
  label: string;
  icon: (props: { className?: string }) => ReactElement;
}

const PRIMARY_LINKS: NavLink[] = [
  { href: '/', label: 'Repositorios', icon: RepositoriesIcon },
  { href: '/overview', label: 'Pendientes', icon: PendingIcon },
  { href: '/developers', label: 'Developers', icon: DevelopersIcon },
];

const ADMIN_LINKS: NavLink[] = [
  { href: '/users', label: 'Usuarios', icon: UsersIcon },
  { href: '/accounts', label: 'Cuentas GitHub', icon: AccountsIcon },
  { href: '/settings', label: 'Configuración', icon: SettingsIcon },
];

function NavRow({ link, active }: { link: NavLink; active: boolean }) {
  const Icon = link.icon;
  return (
    <Link href={link.href} className={`nav-item${active ? ' active' : ''}`}>
      <Icon />
      {link.label}
    </Link>
  );
}

export function Sidebar({ orgLabel, isAdmin }: { orgLabel: string; isAdmin: boolean }) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname?.startsWith(`${href}/`);
  }

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="mark">
          <ShieldIcon />
        </div>
        <div>
          <strong>DevSentinel</strong>
          <span>{orgLabel}</span>
        </div>
      </div>

      <nav className="nav-group">
        {(isAdmin ? PRIMARY_LINKS : [PRIMARY_LINKS[0]]).map((link) => (
          <NavRow key={link.href} link={link} active={isActive(link.href)} />
        ))}
      </nav>

      {isAdmin && (
        <nav className="nav-group">
          <div className="nav-label">Administración</div>
          {ADMIN_LINKS.map((link) => (
            <NavRow key={link.href} link={link} active={isActive(link.href)} />
          ))}
        </nav>
      )}

      <div className="nav-spacer" />

      <nav className="nav-group">
        <NavRow link={{ href: '/me', label: 'Mi perfil', icon: UsersIcon }} active={isActive('/me')} />
      </nav>
    </aside>
  );
}
