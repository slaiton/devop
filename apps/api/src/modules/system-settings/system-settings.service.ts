import { ForbiddenException, Injectable } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { getSystemSettings, updateSystemSettings, isConfigured, type SystemSettings } from '@devsentinel/settings';

export type SystemSettingsUpdateInput = Partial<SystemSettings>;

@Injectable()
export class SystemSettingsService {
  async getStatus(): Promise<{ configured: boolean }> {
    const settings = await getSystemSettings(getPool());
    return { configured: isConfigured(settings) };
  }

  async bootstrap(input: SystemSettingsUpdateInput): Promise<{ configured: boolean }> {
    const existing = await getSystemSettings(getPool());
    if (isConfigured(existing)) {
      throw new ForbiddenException('el sistema ya está configurado — usa /settings con una cuenta admin');
    }
    const updated = await updateSystemSettings(getPool(), input);
    return { configured: isConfigured(updated) };
  }

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
      githubAppId: settings?.githubAppId ?? null,
      githubAppSlug: settings?.githubAppSlug ?? null,
      githubAppClientId: settings?.githubAppClientId ?? null,
      githubAppClientSecretSet: Boolean(settings?.githubAppClientSecret),
      githubAppPrivateKeySet: Boolean(settings?.githubAppPrivateKey),
      githubAppWebhookSecretSet: Boolean(settings?.githubAppWebhookSecret),
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
