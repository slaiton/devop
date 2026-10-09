import { createHash, randomBytes } from 'crypto';
import { getPool } from '@devsentinel/database';

export type AccountTokenPurpose = 'verify_email' | 'reset_password';

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Genera un token de un solo uso (256 bits) y guarda SOLO su hash: quien lea la base de
 * datos no puede reconstruir un enlace válido. Crear uno nuevo invalida los anteriores
 * del mismo propósito, así el último correo enviado es siempre el único vigente. */
export async function createAccountToken(userId: string, purpose: AccountTokenPurpose, ttlMinutes: number): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await getPool().query(`UPDATE account_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [
    userId,
    purpose,
  ]);
  await getPool().query(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, purpose, hashToken(raw), ttlMinutes],
  );
  return raw;
}

/** Consume el token de forma atómica (un solo uso aunque lleguen dos requests a la vez).
 * Devuelve el usuario o null si no existe, ya se usó o venció. */
export async function consumeAccountToken(raw: string, purpose: AccountTokenPurpose): Promise<string | null> {
  const { rows } = await getPool().query(
    `UPDATE account_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(raw), purpose],
  );
  return rows[0]?.user_id ?? null;
}
