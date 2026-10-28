import { Controller, Get, MessageEvent, Req, Sse, UseGuards } from '@nestjs/common';
import { Observable, interval, merge, timer } from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';
import { JwtAuthGuard, type RequestWithSession } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { NotificationsService, type ReviewEvent } from './notifications.service';
import { DEFAULT_NOTIFICATION_SOUND, NOTIFICATION_SOUNDS } from './sounds';

const PING_MS = Number(process.env.NOTIFY_PING_MS) || 25_000;

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Tonos que el admin puede asignar a cada desarrollador (los sintetiza el navegador). */
  @Get('sounds')
  sounds() {
    return { default: DEFAULT_NOTIFICATION_SOUND, sounds: NOTIFICATION_SOUNDS };
  }

  /** Aviso en vivo (Server-Sent Events) de los análisis que terminan. Se corta cuando vence el token de la sesión: el
   * navegador reconecta solo con la cookie renovada, y si la sesión ya no vale, la reconexión da 401 y se detiene. Cada
   * 25 s envía un `ping` para que los proxies no cierren una conexión "quieta". */
  @Sse('stream')
  stream(@Req() req: RequestWithSession): Observable<MessageEvent> {
    const session = req.session!;
    const expiresInMs = Math.max(1_000, (session.exp ?? 0) * 1000 - Date.now());

    const events = new Observable<MessageEvent>((subscriber) => {
      const unsubscribe = this.notifications.subscribe(session.orgId, {
        userId: session.sub,
        role: session.role === 'admin' ? 'admin' : 'user',
        push: (event: ReviewEvent) => subscriber.next({ type: 'review', id: event.reviewRunId, data: event }),
      });
      subscriber.next({ type: 'ready', data: { role: session.role === 'admin' ? 'admin' : 'user' } });
      return unsubscribe;
    });
    const pings = interval(PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));

    return merge(events, pings).pipe(takeUntil(timer(expiresInMs)));
  }
}
