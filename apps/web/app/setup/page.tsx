import { redirect } from 'next/navigation';
import { FirstAdminForm } from './FirstAdminForm';
import { ShieldIcon } from '../components/icons';

async function fetchStatus(): Promise<{ configured: boolean }> {
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/users/bootstrap-status`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load setup status: ${res.status}`);
  return res.json();
}

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
          Esta pantalla solo está disponible mientras no exista ninguna organización todavía. Registrá la
          organización y el primer admin (correo + contraseña) — con eso ya podés iniciar sesión. La
          GitHub App se conecta después, ya logueado, desde <code>/accounts</code>, y el proveedor LLM/SMTP
          desde <code>/settings</code>.
        </p>

        <div className="card">
          <FirstAdminForm />
        </div>
      </div>
    </div>
  );
}
