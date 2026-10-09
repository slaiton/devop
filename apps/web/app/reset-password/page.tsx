import { ResetPasswordForm } from '../components/AccountLinkForms';
import { ShieldIcon } from '../components/icons';

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="login-screen">
      <div className="login-grid-bg" />
      <div className="login-card">
        <div className="brand-mark">
          <ShieldIcon />
        </div>
        <h1>Elige una contraseña nueva</h1>
        <p className="tagline">Después de guardarla podrás iniciar sesión; tus otras sesiones se cerrarán.</p>
        <ResetPasswordForm token={token ?? null} />
      </div>
    </div>
  );
}
