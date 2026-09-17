import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { getPool, withTenant } from '@devsentinel/database';

interface BootstrapFirstAdminInput {
  githubAccountLogin: string;
  organizationName?: string;
  adminEmail: string;
  adminName?: string;
}

@Injectable()
export class UsersService {
  /** Público y de un solo uso: crea la primera organización + su primer admin, antes
   * de que exista ninguna. Se autobloquea apenas hay alguna organización — mismo
   * criterio que `SystemSettingsService.bootstrap`. El slug DEBE coincidir con la
   * cuenta/org de GitHub donde se instalará la GitHub App, porque
   * `handleInstallationCreated` (webhook) reutiliza ese mismo slug vía
   * `ensureOrganization()` — si no coincide, esa instalación crea una org duplicada. */
  async bootstrapFirstAdmin(input: BootstrapFirstAdminInput): Promise<{ organizationId: string; userId: string }> {
    if (!input.githubAccountLogin?.trim() || !input.adminEmail?.trim()) {
      throw new BadRequestException('la cuenta de GitHub y el correo del primer admin son obligatorios');
    }
    const pool = getPool();
    const { rows: existingOrgs } = await pool.query('SELECT count(*)::int AS n FROM organizations');
    if (existingOrgs[0].n > 0) {
      throw new ForbiddenException('ya existe una organización configurada — gestiona usuarios desde /users ya logueado');
    }

    const slug = input.githubAccountLogin.trim().toLowerCase();
    const { rows: orgRows } = await pool.query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [
      input.organizationName?.trim() || input.githubAccountLogin.trim(),
      slug,
    ]);
    const organizationId = orgRows[0].id as string;

    const userId = await this.findOrCreatePendingUser(input.adminEmail, input.adminName);

    return withTenant(organizationId, async (client) => {
      await client.query(`INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        organizationId,
        userId,
      ]);
      return { organizationId, userId };
    });
  }

  /** Identidad `users` compartida entre organizaciones: si el correo ya existe (p. ej.
   * la misma persona invitada a otra org), se reutiliza la fila en vez de duplicarla.
   * `github_user_id` queda NULL — se reclama automáticamente en el primer login cuyo
   * correo de GitHub coincida (ver `AuthService.resolveRegisteredUser`). */
  private async findOrCreatePendingUser(email: string, name: string | undefined): Promise<string> {
    const pool = getPool();
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    if (existing[0]) return existing[0].id as string;
    const { rows } = await pool.query('INSERT INTO users (github_user_id, email, name) VALUES (NULL, $1, $2) RETURNING id', [
      email.trim(),
      name?.trim() || null,
    ]);
    return rows[0].id as string;
  }

  async list(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT om.role, om.created_at, u.id AS user_id, u.name, u.email, u.avatar_url,
                (u.github_user_id IS NOT NULL) AS claimed,
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

  async create(orgId: string, input: { email: string; name?: string; role: string }) {
    if (!input.email?.trim()) throw new BadRequestException('el correo es obligatorio');
    if (!['admin', 'user'].includes(input.role)) throw new BadRequestException('rol inválido');

    const userId = await this.findOrCreatePendingUser(input.email, input.name);

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

    return this.getOne(orgId, userId);
  }

  async update(orgId: string, userId: string, input: { name?: string; role?: string }) {
    if (input.role && !['admin', 'user'].includes(input.role)) throw new BadRequestException('rol inválido');

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

    return this.getOne(orgId, userId);
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
