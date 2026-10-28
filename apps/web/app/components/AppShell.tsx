import type { ReactNode } from 'react';
import type { Session } from '../session';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Footer } from './Footer';
import { SessionKeeper } from './SessionKeeper';

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const isAdmin = session.role === 'admin';
  return (
    <div className="shell">
      <Sidebar orgLabel={session.orgName ?? 'Tu organización'} isAdmin={isAdmin} />
      <Header name={session.name} avatarUrl={session.avatarUrl} role={session.role} />
      <main className="app-main">{children}</main>
      <Footer />
      <SessionKeeper expiresAt={session.sessionExpiresAt} ttlMs={session.sessionTtlMs} />
    </div>
  );
}
