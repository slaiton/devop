import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '../session';
import { AppShell } from '../components/AppShell';
import { PasswordChangeGate } from '../components/PasswordChangeGate';

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect('/');
  }
  if (session.mustChangePassword) {
    return <PasswordChangeGate />;
  }

  return <AppShell session={session}>{children}</AppShell>;
}
