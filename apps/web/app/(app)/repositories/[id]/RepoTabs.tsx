'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function RepoTabs({ repositoryId, isAdmin }: { repositoryId: string; isAdmin: boolean }) {
  const pathname = usePathname();
  const root = `/repositories/${repositoryId}`;

  const tabs = [
    { href: root, label: 'Pushes', exact: true },
    { href: `${root}/pull-requests`, label: 'Pull requests', exact: false },
    { href: `${root}/issues`, label: 'Issues', exact: false },
    ...(isAdmin
      ? [
          { href: `${root}/project-profile`, label: 'Perfil del proyecto', exact: false },
          { href: `${root}/settings`, label: 'Configuración', exact: false },
        ]
      : []),
  ];

  return (
    <nav className="repo-tabs">
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname?.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={`repo-tab${active ? ' repo-tab-active' : ''}`}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
