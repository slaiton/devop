import { Injectable, Logger } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import type { ClientInfo } from '../../common/session';

/** Bitácora de eventos de seguridad (login fallido, cuenta bloqueada, passkey agregada o
 * borrada, recuperación…). Nunca debe romper la operación principal: si no se puede
 * escribir, solo se loguea. No se guardan challenges ni material de credenciales. */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  async record(
    userId: string | null,
    event: string,
    client?: ClientInfo,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await getPool().query(
        'INSERT INTO security_events (user_id, event, ip, user_agent, metadata) VALUES ($1, $2, $3, $4, $5)',
        [userId, event, client?.ip ?? null, client?.userAgent ?? null, JSON.stringify(metadata)],
      );
    } catch (err) {
      this.logger.error(`no se pudo registrar el evento de seguridad '${event}': ${(err as Error).message}`);
    }
  }
}
