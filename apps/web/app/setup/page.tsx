import { redirect } from 'next/navigation';
import { SystemSettingsForm, type SystemSettingsInitial } from '../SystemSettingsForm';

async function fetchStatus(): Promise<{ configured: boolean }> {
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/system-settings/status`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load setup status: ${res.status}`);
  return res.json();
}

const EMPTY: SystemSettingsInitial = {
  githubAppId: null,
  githubAppSlug: null,
  githubAppClientId: null,
  githubAppClientSecretSet: false,
  githubAppPrivateKeySet: false,
  githubAppWebhookSecretSet: false,
  llmProviderBaseUrl: null,
  llmModel: null,
  llmProviderApiKeySet: false,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpFrom: null,
  smtpPasswordSet: false,
};

export default async function SetupPage() {
  const { configured } = await fetchStatus();
  if (configured) {
    redirect('/');
  }

  return (
    <main>
      <h1>Configurar DevSentinel AI</h1>
      <p>
        Esta pantalla solo está disponible mientras el sistema no tenga configurada la GitHub App
        (login OAuth). Completa al menos la sección de GitHub App para poder iniciar sesión — LLM
        y SMTP se pueden dejar para después, desde <code>/settings</code> ya logueado.
      </p>
      <SystemSettingsForm endpoint="/api/system-settings/bootstrap" method="POST" initial={EMPTY} redirectOnSuccess="/" />
    </main>
  );
}
