import { redirect } from 'next/navigation';
import { SystemSettingsForm, type SystemSettingsInitial } from '../SystemSettingsForm';
import { FirstAdminForm } from './FirstAdminForm';
import { ShieldIcon } from '../components/icons';

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
    <div className="setup-screen">
      <div className="setup-inner">
        <div className="setup-brand">
          <div className="mark">
            <ShieldIcon />
          </div>
          <strong>Configurar DevSentinel AI</strong>
        </div>
        <p>
          Esta pantalla solo está disponible mientras el sistema no tenga configurada la GitHub App
          (login OAuth). Hay dos pasos, <strong>en este orden</strong> — el segundo te saca de esta
          pantalla apenas lo guardas, así que completá primero el registro de organización y admin.
        </p>

        <h2>1. Organización y primer admin</h2>
        <p>
          Registrá la organización y el correo del primer admin — sin esto, nadie podrá iniciar sesión
          todavía, incluso con GitHub App/LLM ya configurados.
        </p>
        <div className="card">
          <FirstAdminForm />
        </div>

        <h2>2. GitHub App / LLM / SMTP</h2>
        <p>
          Completá al menos la sección de GitHub App para poder iniciar sesión — LLM y SMTP se pueden
          dejar para después, desde <code>/settings</code> ya logueado. Al guardar te lleva a la
          pantalla de login.
        </p>
        <div className="card">
          <SystemSettingsForm endpoint="/api/system-settings/bootstrap" method="POST" initial={EMPTY} redirectOnSuccess="/" />
        </div>
      </div>
    </div>
  );
}
