import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../modules/auth/auth.service';
import { ROLES_KEY } from './roles.decorator';
import type { RequestWithSession } from './jwtAuth.guard';

/** Corre después de JwtAuthGuard: rutas sin @Roles quedan abiertas a cualquier miembro
 * autenticado; el rol se resuelve contra org_memberships en cada request (no se hornea
 * en el JWT) para que revocar/cambiar el rol de alguien aplique de inmediato. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const session = req.session!;

    const role = await this.authService.getMembershipRole(session.orgId, session.sub);
    if (!role) throw new ForbiddenException('not a member of this organization');
    session.role = role;

    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException(`requires role: ${requiredRoles.join(' or ')}`);
    }
    return true;
  }
}
