import { Injectable, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { getPool, withTenant } from '@devsentinel/database';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  async hashPassword(plain: string): Promise<string> {
    return hash(plain, BCRYPT_ROUNDS);
  }

  /** Login local: correo + contraseña contra `users.password_hash`, sin pasar por
   * GitHub — hay gente sin ninguna relación con las GitHub Apps conectadas (viewers,
   * stakeholders) que igual necesita entrar. Mensaje de error genérico en ambos casos
   * (no existe / contraseña incorrecta) para no filtrar qué correos están registrados. */
  async login(email: string, password: string): Promise<{ userId: string }> {
    const { rows } = await getPool().query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [
      email.trim(),
    ]);
    const user = rows[0];
    if (!user?.password_hash) {
      throw new UnauthorizedException('correo o contraseña incorrectos');
    }
    const ok = await compare(password, user.password_hash);
    if (!ok) {
      throw new UnauthorizedException('correo o contraseña incorrectos');
    }
    return { userId: user.id as string };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const currentHash: string | null = rows[0]?.password_hash ?? null;
    if (currentHash) {
      const ok = await compare(currentPassword, currentHash);
      if (!ok) throw new UnauthorizedException('la contraseña actual no es correcta');
    }
    const newHash = await this.hashPassword(newPassword);
    await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
  }

  /** org_memberships tiene RLS, así que resolver el tenant de un usuario sin conocerlo
   * aún exige la función SECURITY DEFINER creada en la migración 0012 (mismo patrón
   * que resolve_organization_for_installation). */
  async findOrganizationForUser(userId: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_user($1) AS organization_id', [userId]);
    return rows[0]?.organization_id ?? null;
  }

  async getMembershipRole(organizationId: string, userId: string): Promise<string | null> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM org_memberships WHERE organization_id = $1 AND user_id = $2',
        [organizationId, userId],
      );
      return rows[0]?.role ?? null;
    });
  }

  /** Sesión corta a propósito: al expirar, `JwtAuthGuard` rechaza el token (401) y el
   * front trata eso como "no logueado" — la única forma de recuperar sesión es volver
   * a pasar por el login (correo/contraseña), sin refresh silencioso. */
  issueSessionToken(userId: string, organizationId: string): string {
    return sign({ sub: userId, orgId: organizationId }, process.env.JWT_SECRET ?? '', { expiresIn: '4h' });
  }
}
