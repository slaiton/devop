import type { ReactNode } from 'react';
import type { Session } from '../session';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Footer } from './Footer';

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const isAdmin = session.role === 'admin';
  return (
    <div className="shell">
      <Sidebar orgLabel={session.orgName ?? 'Tu organización'} isAdmin={isAdmin} />
      <Header name={session.name} avatarUrl={session.avatarUrl} role={session.role} />
      <main className="app-main">{children}</main>
      <Footer />
    </div>
  );
}
