import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithSession } from './jwtAuth.guard';

/** Requiere que RolesGuard haya corrido antes (deja el rol resuelto en req.session.role). */
export const CurrentRole = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<RequestWithSession>();
  return req.session!.role!;
});
