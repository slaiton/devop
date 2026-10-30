import { cookies } from 'next/headers';
import { getSession } from '../../session';
import { AiAgentsPanel, type AgentsConfig } from '../../components/AiAgentsPanel';
import { AuditBudgetPanel, type AuditBudgetData } from '../../components/AuditBudgetPanel';
import { SystemSettingsForm, type SystemSettingsInitial } from '../../SystemSettingsForm';

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export default async function SettingsPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const [settings, agents, budget] = await Promise.all([
    fetchJson<SystemSettingsInitial>('/system-settings'),
    fetchJson<AgentsConfig>('/system-settings/llm'),
    fetchJson<AuditBudgetData>('/system-settings/audit-budget'),
  ]);

  return (
    <>
      <h1>Configuración del sistema</h1>
      <p>
        Agentes de IA (con su orden de uso) y SMTP. Las GitHub Apps se gestionan aparte, desde <code>/accounts</code>.
      </p>
      <AiAgentsPanel initial={agents} />
      <AuditBudgetPanel initial={budget} />
      <SystemSettingsForm endpoint="/api/system-settings" method="PATCH" initial={settings} />
    </>
  );
}
