import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { RepositoryReadinessService } from './repositoryReadiness.service';

@Controller('repository-readiness')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class RepositoryReadinessController {
  constructor(private readonly service: RepositoryReadinessService) {}

  /** Aptitud de los repos para recibir pushes. Sin `repositoryId` devuelve todos los de la
   * organización; `refresh=1` ignora el caché de 60 s (botón "Reverificar"). */
  @Get()
  check(
    @CurrentOrg() orgId: string,
    @Query('repositoryId') repositoryId: string | undefined,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.service.check(orgId, { repositoryId: repositoryId || undefined, refresh: refresh === '1' });
  }
}
