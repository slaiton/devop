import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithSession } from './jwtAuth.guard';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<RequestWithSession>();
  return req.session!.sub;
});
