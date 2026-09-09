import { cookies } from 'next/headers';

export interface Session {
  userId: string;
  orgId: string;
  role: 'admin' | 'developer' | 'owner' | 'viewer' | null;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export async function getSession(): Promise<Session | null> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/auth/github/me`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}
