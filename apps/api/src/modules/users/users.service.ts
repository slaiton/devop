import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { getPool, withTenant } from '@devsentinel/database';
import type { ClientInfo } from '../../common/session';
import { AccountService } from '../auth/account.service';
import { PasskeysService } from '../passkeys/passkeys.service';

const BCRYPT_ROUNDS = 12;

interface BootstrapFirstAdminInput {
  organizationSlug: string;
  organizationName?: string;
  adminEmail: string;
  adminName?: string;
  adminPassword: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly account: AccountService,
    private readonly passkeys: PasskeysService,
  ) {}

  /** Público y de un solo uso: crea la primera organización + su primer admin, antes
   * de que exista ninguna. Se autobloquea apenas hay alguna organización — mismo
   * criterio que `SystemSettingsService.bootstrap`. Las GitHub Apps se conectan
   * después, ya logueado, desde /accounts — este paso ya no depende de GitHub. */
  async bootstrapFirstAdmin(input: BootstrapFirstAdminInput): Promise<{ organizationId: string; userId: string }> {
    if (!input.organizationSlug?.trim() || !input.adminEmail?.trim()) {
      throw new BadRequestException('el identificador de la organización y el correo del primer admin son obligatorios');
    }
    if (!input.adminPassword || input.adminPassword.length < 8) {
      throw new BadRequestException('la contraseña del primer admin debe tener al menos 8 caracteres');
    }
    const pool = getPool();
    const { rows: existingOrgs } = await pool.query('SELECT count(*)::int AS n FROM organizations');
    if (existingOrgs[0].n > 0) {
      throw new ForbiddenException('ya existe una organización configurada — gestiona usuarios desde /users ya logueado');
    }

    const slug = input.organizationSlug.trim().toLowerCase();
    const { rows: orgRows } = await pool.query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [
      input.organizationName?.trim() || input.organizationSlug.trim(),
      slug,
    ]);
    const organizationId = orgRows[0].id as string;

    const passwordHash = await hash(input.adminPassword, BCRYPT_ROUNDS);
    // El primer admin escribe su propio correo en /setup, cuando todavía no puede haber SMTP
    // configurado para verificarlo: se da por confirmado (es quien instala el sistema).
    const { id: userId } = await this.findOrCreatePendingUser(input.adminEmail, input.adminName, passwordHash, {
      mustChangePassword: false,
      emailVerified: true,
    });

    return withTenant(organizationId, async (client) => {
      await client.query(`INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        organizationId,
        userId,
      ]);
      return { organizationId, userId };
    });
  }

  /** Existencia de organizaciones — reemplaza el viejo gate "¿hay GitHub App
   * configurada?" de `system-settings/status`, que dejó de tener sentido apenas el
   * login local no depende de GitHub. `/setup` y `page.tsx` lo consultan público. */
  async hasAnyOrganization(): Promise<boolean> {
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM organizations');
    return rows[0].n > 0;
  }

  /** Identidad `users` compartida entre organizaciones: si el correo ya existe (p. ej.
   * la misma persona invitada a otra org), se reutiliza la fila en vez de duplicarla y
   * NO se toca su contraseña. `passwordHash` y las marcas solo aplican al crear la fila. */
  private async findOrCreatePendingUser(
    email: string,
    name: string | undefined,
    passwordHash: string | null,
    flags: { mustChangePassword: boolean; emailVerified: boolean },
  ): Promise<{ id: string; created: boolean }> {
    const pool = getPool();
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    if (existing[0]) return { id: existing[0].id as string, created: false };
    const { rows } = await pool.query(
      `INSERT INTO users (github_user_id, email, name, password_hash, must_change_password, email_verified_at)
       VALUES (NULL, $1, $2, $3, $4, CASE WHEN $5::boolean THEN now() ELSE NULL END) RETURNING id`,
      [email.trim(), name?.trim() || null, passwordHash, flags.mustChangePassword, flags.emailVerified],
    );
    return { id: rows[0].id as string, created: true };
  }

  async list(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT om.role, om.created_at, u.id AS user_id, u.name, u.email, u.avatar_url,
                (u.password_hash IS NOT NULL) AS claimed,
                u.email_verified_at,
                (SELECT count(*)::int FROM webauthn_credentials c WHERE c.user_id = u.id) AS passkey_count,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object('id', r.id, 'full_name', r.full_name) ORDER BY r.full_name)
                   FROM repository_members rm JOIN repositories r ON r.id = rm.repository_id
                   WHERE rm.user_id = u.id AND rm.organization_id = om.organization_id),
                  '[]'::jsonb
                ) AS repositories,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object('id', d.id, 'github_login', d.github_login, 'email', d.email) ORDER BY d.created_at)
                   FROM developers d WHERE d.user_id = u.id AND d.organization_id = om.organization_id),
                  '[]'::jsonb
                ) AS developers
         FROM org_memberships om
         JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = $1
         ORDER BY om.created_at`,
        [orgId],
      );
      return rows;
    });
  }

  private async getOne(orgId: string, userId: string) {
    const rows = await this.list(orgId);
    return rows.find((r: any) => r.user_id === userId) ?? null;
  }

  async create(orgId: string, input: { email: string; name?: string; role: string; password: string }) {
    if (!input.email?.trim()) throw new BadRequestException('el correo es obligatorio');
    if (!['admin', 'user'].includes(input.role)) throw new BadRequestException('rol inválido');
    if (!input.password || input.password.length < 8) {
      throw new BadRequestException('la contraseña debe tener al menos 8 caracteres');
    }

    const passwordHash = await hash(input.password, BCRYPT_ROUNDS);
    // Contraseña fijada por un admin = temporal: la persona debe cambiarla en su primer
    // ingreso (y puede enrolar su passkey desde "Mi perfil").
    const { id: userId, created } = await this.findOrCreatePendingUser(input.email, input.name, passwordHash, {
      mustChangePassword: true,
      emailVerified: false,
    });

    await withTenant(orgId, async (client) => {
      const { rows: existingMembership } = await client.query(
        'SELECT id FROM org_memberships WHERE organization_id = $1 AND user_id = $2',
        [orgId, userId],
      );
      if (existingMembership[0]) throw new BadRequestException('ese correo ya es miembro de esta organización');

      await client.query('INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [
        orgId,
        userId,
        input.role,
      ]);
    });

    // Un fallo de envío (SMTP sin configurar) no debe impedir crear el usuario; el admin
    // puede reenviar la verificación desde la lista cuando SMTP esté listo.
    const verificationEmailSent = created ? await this.account.sendVerificationEmail(userId) : false;
    return { ...(await this.getOne(orgId, userId)), verification_email_sent: verificationEmailSent };
  }

  async update(
    orgId: string,
    userId: string,
    input: { name?: string; role?: string; password?: string },
    actorUserId: string,
  ) {
    if (input.role && !['admin', 'user'].includes(input.role)) throw new BadRequestException('rol inválido');
    if (input.password !== undefined && input.password.length < 8) {
      throw new BadRequestException('la contraseña debe tener al menos 8 caracteres');
    }

    await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM org_memberships WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        userId,
      ]);
      if (!rows[0]) throw new NotFoundException('usuario no encontrado en esta organización');

      if (input.role) {
        await client.query('UPDATE org_memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3', [
          input.role,
          orgId,
          userId,
        ]);
      }
    });

    if (input.name !== undefined) {
      await getPool().query('UPDATE users SET name = $1 WHERE id = $2', [input.name.trim() || null, userId]);
    }

    if (input.password) {
      const passwordHash = await hash(input.password, BCRYPT_ROUNDS);
      if (userId === actorUserId) {
        // Cambio sobre sí mismo: es lo mismo que hacerlo desde "Mi perfil", sin forzar nada.
        await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
      } else {
        // Contraseña fijada por un admin para otra persona: temporal. Cierra las sesiones
        // abiertas de esa cuenta, la obliga a cambiarla y levanta un bloqueo por intentos.
        await getPool().query(
          `UPDATE users
           SET password_hash = $1, must_change_password = true, session_version = session_version + 1,
               failed_login_attempts = 0, locked_until = NULL
           WHERE id = $2`,
          [passwordHash, userId],
        );
      }
    }

    return this.getOne(orgId, userId);
  }

  private async assertMember(orgId: string, userId: string): Promise<void> {
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM org_memberships WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
      if (!rows[0]) throw new NotFoundException('usuario no encontrado en esta organización');
    });
  }

  /** Quita todas las passkeys de alguien (y cierra sus sesiones) — la salida cuando perdió
   * sus dispositivos. Después puede entrar con su contraseña y registrar una nueva. */
  async revokePasskeys(orgId: string, userId: string, actorUserId: string, client: ClientInfo): Promise<{ revoked: number }> {
    await this.assertMember(orgId, userId);
    return { revoked: await this.passkeys.revokeAll(userId, actorUserId, client) };
  }

  async resendVerification(orgId: string, userId: string): Promise<{ sent: boolean }> {
    await this.assertMember(orgId, userId);
    return { sent: await this.account.sendVerificationEmail(userId) };
  }

  /** Quita la membresía (y el acceso a repos) de ESTA organización — no borra la fila
   * `users`, que es una identidad compartida con historial referenciado desde otras
   * tablas (findings.resolved_by, review_runs.reviewed_by, etc.) y potencialmente otras
   * organizaciones. */
  async remove(orgId: string, userId: string): Promise<void> {
    await withTenant(orgId, async (client) => {
      await client.query('DELETE FROM repository_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
      const { rowCount } = await client.query('DELETE FROM org_memberships WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        userId,
      ]);
      if (!rowCount) throw new NotFoundException('usuario no encontrado en esta organización');
    });
  }

  /** Reemplaza el set completo de repos asignados — más simple para el formulario del
   * CRUD (un multi-select) que ir agregando/quitando uno por uno. */
  async setRepoAccess(orgId: string, userId: string, repositoryIds: string[]): Promise<void> {
    await withTenant(orgId, async (client) => {
      const { rows: membership } = await client.query(
        'SELECT id FROM org_memberships WHERE organization_id = $1 AND user_id = $2',
        [orgId, userId],
      );
      if (!membership[0]) throw new NotFoundException('usuario no encontrado en esta organización');

      if (repositoryIds.length) {
        const { rows: validRepos } = await client.query('SELECT id FROM repositories WHERE id = ANY($1::uuid[])', [
          repositoryIds,
        ]);
        if (validRepos.length !== repositoryIds.length) {
          throw new BadRequestException('alguno de los repositorios indicados no existe en esta organización');
        }
      }

      await client.query('DELETE FROM repository_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
      for (const repositoryId of repositoryIds) {
        await client.query('INSERT INTO repository_members (organization_id, repository_id, user_id) VALUES ($1, $2, $3)', [
          orgId,
          repositoryId,
          userId,
        ]);
      }
    });
  }

  async listUnlinkedDevelopers(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, github_login, email, display_name FROM developers
         WHERE organization_id = $1 AND user_id IS NULL
         ORDER BY display_name NULLS LAST`,
        [orgId],
      );
      return rows;
    });
  }

  async linkDeveloper(orgId: string, userId: string, developerId: string): Promise<void> {
    await withTenant(orgId, async (client) => {
      const { rowCount } = await client.query(
        'UPDATE developers SET user_id = $1 WHERE id = $2 AND organization_id = $3',
        [userId, developerId, orgId],
      );
      if (!rowCount) throw new NotFoundException('developer no encontrado');
    });
  }
}
