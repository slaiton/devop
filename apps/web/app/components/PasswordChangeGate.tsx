import { ChangePasswordForm } from './ChangePasswordForm';
import { ShieldIcon } from './icons';

/** Pantalla única para quien entró con una contraseña temporal (la genérica sembrada o la que
 * fijó un admin). La API rechaza cualquier otra ruta con PASSWORD_CHANGE_REQUIRED, así que
 * ninguna página puede intentar cargar datos mientras este bloqueo siga activo. */
export function PasswordChangeGate() {
  return (
    <div className="login-screen">
      <div className="login-grid-bg" />
      <div className="login-card">
        <div className="brand-mark">
          <ShieldIcon />
        </div>
        <h1>Cambia tu contraseña</h1>
        <p className="tagline">
          Tu contraseña actual es temporal. Elige una nueva para continuar; después podrás agregar una passkey desde "Mi perfil".
        </p>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
