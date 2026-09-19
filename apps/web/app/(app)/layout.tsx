import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '../session';
import { AppShell } from '../components/AppShell';

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect('/');
  }

  return <AppShell session={session}>{children}</AppShell>;
}
