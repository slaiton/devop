import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verify } from 'jsonwebtoken';
import type { Request } from 'express';

export interface SessionPayload {
  sub: string;
  orgId: string;
}

export type RequestWithSession = Request & { session?: SessionPayload };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const token = req.cookies?.session;
    if (!token) {
      throw new UnauthorizedException('missing session cookie');
    }
    try {
      req.session = verify(token, process.env.JWT_SECRET ?? '') as SessionPayload;
      return true;
    } catch {
      throw new UnauthorizedException('invalid or expired session');
    }
  }
}
