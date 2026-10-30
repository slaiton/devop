import { Module } from '@nestjs/common';
import { SandboxRunnerService } from '../review/sandboxRunner.service';
import { Layer1Service } from './layer1.service';
import { Layer2Service } from './layer2/layer2.service';

/** Auditoría por capas: la capa 1 (escáneres deterministas) y, a medida que se agreguen, las siguientes. El ejecutor de
 * contenedores aislados se comparte con el análisis estático de siempre. */
@Module({
  providers: [SandboxRunnerService, Layer1Service, Layer2Service],
  exports: [SandboxRunnerService, Layer1Service, Layer2Service],
})
export class AuditModule {}
