import { cookies } from 'next/headers';
import { getSession } from '../../session';
import { WebhookLog, type Delivery, type Summary } from './WebhookLog';

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export default async function WebhooksPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const [summary, page] = await Promise.all([
    fetchJson<Summary>('/webhook-log/summary'),
    fetchJson<{ items: Delivery[]; hasMore: boolean }>('/webhook-log?limit=50'),
  ]);

  return (
    <>
      <h1>Webhooks</h1>
      <p style={{ color: 'var(--ink-muted)' }}>
        Registro de todo lo que GitHub envía a DevSentinel, App por App: qué llegó, qué se hizo con cada evento y, si no se
        procesó, por qué. Es la forma de saber si una GitHub App realmente está mandando pushes.
      </p>
      <WebhookLog initialSummary={summary} initialPage={page} />
    </>
  );
}
