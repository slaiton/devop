import { ForgotPasswordForm } from '../components/AccountLinkForms';
import { ShieldIcon } from '../components/icons';

export default function ForgotPasswordPage() {
  return (
    <div className="login-screen">
      <div className="login-grid-bg" />
      <div className="login-card">
        <div className="brand-mark">
          <ShieldIcon />
        </div>
        <h1>Recuperar contraseña</h1>
        <p className="tagline">Te enviamos un enlace de un solo uso al correo registrado en tu cuenta.</p>
        <ForgotPasswordForm />
      </div>
    </div>
  );
}
