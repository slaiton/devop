import { VerifyEmailForm } from '../components/AccountLinkForms';
import { ShieldIcon } from '../components/icons';

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="login-screen">
      <div className="login-grid-bg" />
      <div className="login-card">
        <div className="brand-mark">
          <ShieldIcon />
        </div>
        <h1>Verifica tu correo</h1>
        <p className="tagline">Confirma que esta dirección es tuya para poder recuperar tu cuenta y recibir avisos de seguridad.</p>
        <VerifyEmailForm token={token ?? null} />
      </div>
    </div>
  );
}
