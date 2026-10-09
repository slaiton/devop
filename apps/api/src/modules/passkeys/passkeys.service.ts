import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getPool } from '@devsentinel/database';
import type { ClientInfo } from '../../common/session';
import { AccountService } from '../auth/account.service';
import { SecurityEventsService } from '../auth/securityEvents.service';
import { getWebAuthnConfig } from './webauthn.config';

const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_PASSKEYS_PER_USER = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AAGUIDs de proveedores conocidos, solo para ponerle un nombre legible a la passkey. Muchos
// autenticadores (p. ej. iCloud con attestation "none") reportan AAGUID en ceros: en ese caso
// el nombre sale del tipo de transporte y el usuario puede renombrarla.
const KNOWN_AUTHENTICATORS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome en Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
};

export interface PasskeySummary {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  synced: boolean;
  transports: string[];
}

type ChallengePurpose = 'register' | 'login' | 'reauth';

@Injectable()
export class PasskeysService {
  private readonly logger = new Logger(PasskeysService.name);

  constructor(
    private readonly events: SecurityEventsService,
    private readonly account: AccountService,
  ) {}

  // ---------- challenges (un solo uso, 5 min) ----------

  private async storeChallenge(challenge: string, purpose: ChallengePurpose, userId: string | null): Promise<string> {
    await getPool().query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
    const { rows } = await getPool().query(
      `INSERT INTO webauthn_challenges (challenge, purpose, user_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
      [challenge, purpose, userId, CHALLENGE_TTL_SECONDS],
    );
    return rows[0].id as string;
  }

  /** DELETE ... RETURNING: dos requests con el mismo challenge no pueden consumirlo ambas. */
  private async consumeChallenge(
    challengeId: string | undefined,
    purpose: ChallengePurpose,
  ): Promise<{ challenge: string; userId: string | null } | null> {
    if (!challengeId || !UUID.test(challengeId)) return null;
    const { rows } = await getPool().query(
      `DELETE FROM webauthn_challenges WHERE id = $1 AND purpose = $2 AND expires_at > now()
       RETURNING challenge, user_id`,
      [challengeId, purpose],
    );
    return rows[0] ? { challenge: rows[0].challenge, userId: rows[0].user_id } : null;
  }

  // ---------- registro ----------

  private async ensureWebauthnUserId(userId: string): Promise<string> {
    const { rows } = await getPool().query(
      'UPDATE users SET webauthn_user_id = COALESCE(webauthn_user_id, $2) WHERE id = $1 RETURNING webauthn_user_id',
      [userId, randomBytes(32).toString('base64url')],
    );
    return rows[0].webauthn_user_id as string;
  }

  async startRegistration(userId: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
    const cfg = getWebAuthnConfig();
    const { rows: userRows } = await getPool().query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (!userRows[0]) throw new NotFoundException('usuario no encontrado');
    const { rows: existing } = await getPool().query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [userId]);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new BadRequestException(`ya tienes el máximo de ${MAX_PASSKEYS_PER_USER} passkeys; borra alguna antes de agregar otra`);
    }
    const handle = await this.ensureWebauthnUserId(userId);

    const options = await generateRegistrationOptions({
      rpName: cfg.rpName,
      rpID: cfg.rpID,
      userName: userRows[0].email ?? userId,
      userDisplayName: userRows[0].name ?? userRows[0].email ?? '',
      userID: Buffer.from(handle, 'base64url'),
      attestationType: 'none', // nunca pedimos attestation: no necesitamos identificar el modelo del autenticador
      // Evita registrar dos veces la misma passkey en el mismo proveedor.
      excludeCredentials: existing.map((c) => ({ id: c.credential_id as string, transports: c.transports as string[] })),
      // residentKey required = passkey "de verdad" (descubrible): permite entrar sin escribir el
      // correo. userVerification required = huella, rostro o PIN del dispositivo siempre.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await this.storeChallenge(options.challenge, 'register', userId);
    return { options, challengeId };
  }

  async finishRegistration(
    userId: string,
    challengeId: string | undefined,
    response: RegistrationResponseJSON,
    requestedName: string | undefined,
    client: ClientInfo,
  ): Promise<PasskeySummary> {
    const cfg = getWebAuthnConfig();
    const challenge = await this.consumeChallenge(challengeId, 'register');
    if (!challenge || challenge.userId !== userId) {
      throw new BadRequestException('la solicitud de registro venció o no es válida, inténtalo de nuevo');
    }

    let info;
    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) throw new Error('no verificada');
      info = verification.registrationInfo;
    } catch (err) {
      this.logger.warn(`registro de passkey rechazado para el usuario ${userId}: ${(err as Error).message}`);
      await this.events.record(userId, 'passkey_register_failed', client, { reason: (err as Error).message.slice(0, 200) });
      throw new BadRequestException('no se pudo verificar la passkey');
    }

    const transports = response.response.transports ?? info.credential.transports ?? [];
    const name = this.sanitizeName(requestedName) ?? this.defaultName(info.aaguid, transports);
    try {
      const { rows } = await getPool().query(
        `INSERT INTO webauthn_credentials
           (user_id, credential_id, public_key, sign_count, transports, backup_eligible, backup_state, aaguid, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, created_at, last_used_at, backup_eligible, transports`,
        [
          userId,
          info.credential.id,
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          transports,
          info.credentialDeviceType === 'multiDevice',
          info.credentialBackedUp,
          info.aaguid,
          name,
        ],
      );
      await this.events.record(userId, 'passkey_added', client, { credentialId: rows[0].id });
      await this.account.notifyAccessChange(userId, 'Nueva passkey en tu cuenta', `Se agregó la passkey <strong>${name.replace(/</g, '&lt;')}</strong> a tu cuenta.`);
      return this.toSummary(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new BadRequestException('esa passkey ya está registrada');
      throw err;
    }
  }

  // ---------- gestión ----------

  async list(userId: string): Promise<PasskeySummary[]> {
    const { rows } = await getPool().query(
      `SELECT id, name, created_at, last_used_at, backup_eligible, transports
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map((r) => this.toSummary(r));
  }

  async rename(userId: string, id: string, name: string): Promise<PasskeySummary> {
    const clean = this.sanitizeName(name);
    if (!clean) throw new BadRequestException('el nombre no puede estar vacío');
    const { rows } = await getPool().query(
      `UPDATE webauthn_credentials SET name = $3 WHERE id = $1 AND user_id = $2
       RETURNING id, name, created_at, last_used_at, backup_eligible, transports`,
      [id, userId, clean],
    );
    if (!rows[0]) throw new NotFoundException('passkey no encontrada');
    return this.toSummary(rows[0]);
  }

  /** Borra una passkey y sube la versión de sesión (cierra las demás sesiones: si se borra
   * por pérdida o robo del dispositivo, no deben seguir abiertas). Devuelve la versión nueva
   * y el credential_id para que el navegador avise al proveedor (signalUnknownCredential). */
  async remove(userId: string, id: string, client: ClientInfo): Promise<{ sessionVersion: number; credentialId: string }> {
    const { rows: userRows } = await getPool().query(
      `SELECT (password_hash IS NOT NULL) AS has_password,
              (SELECT count(*)::int FROM webauthn_credentials WHERE user_id = $1) AS passkeys
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows[0]?.has_password && userRows[0]?.passkeys <= 1) {
      throw new BadRequestException('no puedes borrar tu único método de acceso');
    }
    const { rows } = await getPool().query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING credential_id, name', [id, userId]);
    if (!rows[0]) throw new NotFoundException('passkey no encontrada');
    const sessionVersion = await this.bumpSessionVersion(userId);
    await this.events.record(userId, 'passkey_removed', client, { credentialId: id });
    await this.account.notifyAccessChange(userId, 'Passkey eliminada', `Se eliminó la passkey <strong>${String(rows[0].name).replace(/</g, '&lt;')}</strong> de tu cuenta.`);
    return { sessionVersion, credentialId: rows[0].credential_id };
  }

  /** Para el admin que atiende a alguien que perdió sus dispositivos. */
  async revokeAll(userId: string, actorUserId: string, client: ClientInfo): Promise<number> {
    const { rowCount } = await getPool().query('DELETE FROM webauthn_credentials WHERE user_id = $1', [userId]);
    await this.bumpSessionVersion(userId);
    await this.events.record(userId, 'passkeys_revoked_by_admin', client, { actorUserId, count: rowCount });
    await this.account.notifyAccessChange(userId, 'Passkeys revocadas', 'Un administrador revocó todas las passkeys de tu cuenta y cerró tus sesiones abiertas.');
    return rowCount ?? 0;
  }

  private async bumpSessionVersion(userId: string): Promise<number> {
    const { rows } = await getPool().query('UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version', [userId]);
    return rows[0].session_version as number;
  }

  // ---------- autenticación (login y reautenticación) ----------

  async startAuthentication(
    purpose: 'login' | 'reauth',
    userId?: string,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
    const cfg = getWebAuthnConfig();
    let allowCredentials: { id: string; transports?: string[] }[] | undefined;
    if (purpose === 'reauth') {
      const { rows } = await getPool().query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [userId]);
      if (rows.length === 0) throw new BadRequestException('no tienes passkeys registradas');
      allowCredentials = rows.map((c) => ({ id: c.credential_id as string, transports: c.transports as string[] }));
    }
    // Login sin allowCredentials: el navegador ofrece las passkeys del usuario para este sitio
    // y no hace falta decir de quién — así este endpoint tampoco revela qué correos existen.
    const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required', allowCredentials });
    const challengeId = await this.storeChallenge(options.challenge, purpose, purpose === 'reauth' ? (userId ?? null) : null);
    return { options, challengeId };
  }

  async finishAuthentication(
    challengeId: string | undefined,
    response: AuthenticationResponseJSON,
    purpose: 'login' | 'reauth',
    sessionUserId: string | undefined,
    client: ClientInfo,
  ): Promise<{ userId: string }> {
    const cfg = getWebAuthnConfig();
    const challenge = await this.consumeChallenge(challengeId, purpose);
    if (!challenge) throw new UnauthorizedException('la solicitud venció o no es válida, inténtalo de nuevo');

    const { rows } = await getPool().query(
      `SELECT c.id, c.user_id, c.public_key, c.sign_count, c.transports, u.webauthn_user_id
       FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
       WHERE c.credential_id = $1`,
      [response?.id],
    );
    const stored = rows[0];
    if (!stored) {
      await this.events.record(null, 'passkey_login_unknown_credential', client);
      throw new UnauthorizedException('no se pudo verificar la passkey');
    }
    if (purpose === 'reauth' && (stored.user_id !== sessionUserId || challenge.userId !== sessionUserId)) {
      throw new ForbiddenException('esa passkey no pertenece a tu cuenta');
    }
    // En passkeys descubribles el autenticador devuelve el user handle: debe ser el del dueño.
    const userHandle = response.response?.userHandle;
    if (userHandle && stored.webauthn_user_id && userHandle !== stored.webauthn_user_id) {
      await this.events.record(stored.user_id, 'passkey_login_handle_mismatch', client);
      throw new UnauthorizedException('no se pudo verificar la passkey');
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpID,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(stored.public_key),
          counter: Number(stored.sign_count),
          transports: stored.transports,
        },
      });
      if (!verification.verified) throw new Error('no verificada');
      await getPool().query(
        `UPDATE webauthn_credentials
         SET sign_count = $2, backup_state = $3, last_used_at = now() WHERE id = $1`,
        [stored.id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp],
      );
    } catch (err) {
      // Un contador que no avanza puede indicar una passkey clonada (el estándar §6.1.1).
      this.logger.warn(`autenticación con passkey rechazada (usuario ${stored.user_id}): ${(err as Error).message}`);
      await this.events.record(stored.user_id, 'passkey_auth_failed', client, { reason: (err as Error).message.slice(0, 200) });
      throw new UnauthorizedException('no se pudo verificar la passkey');
    }

    await this.events.record(stored.user_id, purpose === 'login' ? 'login_passkey' : 'reauth_passkey', client);
    return { userId: stored.user_id as string };
  }

  // ---------- helpers ----------

  private sanitizeName(name: string | undefined): string | null {
    const clean = (name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    return clean || null;
  }

  private defaultName(aaguid: string | undefined, transports: string[]): string {
    const known = aaguid ? KNOWN_AUTHENTICATORS[aaguid.toLowerCase()] : undefined;
    if (known) return known;
    if (transports.includes('hybrid')) return 'Teléfono';
    if (transports.includes('usb') || transports.includes('nfc') || transports.includes('ble')) return 'Llave de seguridad';
    if (transports.includes('internal')) return 'Este dispositivo';
    return 'Passkey';
  }

  private toSummary(row: {
    id: string;
    name: string;
    created_at: Date | string;
    last_used_at: Date | string | null;
    backup_eligible: boolean;
    transports: string[];
  }): PasskeySummary {
    return {
      id: row.id,
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
      last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      synced: row.backup_eligible,
      transports: row.transports,
    };
  }
}
