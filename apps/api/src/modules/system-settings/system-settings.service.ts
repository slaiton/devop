import { Injectable } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { getSystemSettings, updateSystemSettings, type SystemSettings } from '@devsentinel/settings';

export type SystemSettingsUpdateInput = Partial<SystemSettings>;

/** Configuración global de LLM/SMTP — ya no incluye GitHub App (ver `github_apps`,
 * gestionada por org desde `/accounts`) ni el gate de "sistema configurado" (ver
 * `UsersService.hasAnyOrganization`, expuesto en `GET /users/bootstrap-status`). */
@Injectable()
export class SystemSettingsService {
  async getMasked() {
    const settings = await getSystemSettings(getPool());
    return this.toMaskedView(settings);
  }

  async update(input: SystemSettingsUpdateInput) {
    const updated = await updateSystemSettings(getPool(), input);
    return this.toMaskedView(updated);
  }

  private toMaskedView(settings: SystemSettings | null) {
    return {
      llmProviderBaseUrl: settings?.llmProviderBaseUrl ?? null,
      llmModel: settings?.llmModel ?? null,
      llmProviderApiKeySet: Boolean(settings?.llmProviderApiKey),
      smtpHost: settings?.smtpHost ?? null,
      smtpPort: settings?.smtpPort ?? null,
      smtpUser: settings?.smtpUser ?? null,
      smtpFrom: settings?.smtpFrom ?? null,
      smtpPasswordSet: Boolean(settings?.smtpPassword),
    };
  }
}
