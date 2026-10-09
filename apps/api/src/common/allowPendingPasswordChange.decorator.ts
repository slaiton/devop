import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

/** Marca las pocas rutas que una sesión con cambio de contraseña pendiente (contraseña
 * genérica sembrada o fijada por un admin) puede usar: ver quién es, cambiarla y salir. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
