import { ServiceUnavailableException } from '@nestjs/common';

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  origins: string[];
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/** RP ID y orígenes permitidos. Por defecto salen de PUBLIC_WEB_ORIGIN (en producción,
 * https://devop.slaiton.com → RP ID `devop.slaiton.com`), así que normalmente no hace falta
 * configurar nada más. El RP ID NO se puede cambiar una vez que hay passkeys registradas:
 * cada passkey queda atada a él. WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS existen solo para casos
 * especiales (varios orígenes, o un RP ID padre como `slaiton.com`). */
export function getWebAuthnConfig(): WebAuthnConfig {
  const publicOrigin = trimSlash(process.env.PUBLIC_WEB_ORIGIN ?? '');
  const origins = (process.env.WEBAUTHN_ORIGINS?.trim() || publicOrigin)
    .split(',')
    .map(trimSlash)
    .filter(Boolean);
  const explicitRpId = process.env.WEBAUTHN_RP_ID?.trim();
  const rpID = explicitRpId || (origins[0] ? new URL(origins[0]).hostname : '');

  if (!rpID || origins.length === 0) {
    throw new ServiceUnavailableException('las passkeys no están configuradas en el servidor (falta PUBLIC_WEB_ORIGIN)');
  }
  for (const origin of origins) {
    const host = new URL(origin).hostname;
    if (host !== rpID && !host.endsWith(`.${rpID}`)) {
      throw new ServiceUnavailableException(
        `configuración de passkeys inválida: el origen ${origin} no pertenece al RP ID ${rpID}`,
      );
    }
  }
  return { rpID, rpName: process.env.WEBAUTHN_RP_NAME?.trim() || 'DevSentinel AI', origins };
}
