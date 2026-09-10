import type { AppStateInstance } from '@daevox/framework';
import { TelegramConnection } from './domain/telegram/connection.ts';
import { telegramParameters } from './domain/telegram/config.ts';
import { SecretaryService } from './domain/secretary/service.ts';

export class AppState implements AppStateInstance {
  readonly telegram: TelegramConnection;
  readonly webClientOrigin: string;
  readonly secretary: SecretaryService;

  constructor(
    telegram = new TelegramConnection({ parameters: telegramParameters(process.env) }),
    webClientOrigin = process.env.WEB_CLIENT_ORIGIN ?? 'http://127.0.0.1:5173',
    archiveUrl?: string,
  ) {
    this.telegram = telegram;
    this.webClientOrigin = webClientOrigin;
    this.secretary = new SecretaryService(this.telegram, archiveUrl);
  }
  onAppStart() {
    void this.telegram.start();
    this.secretary.start();
  }
  async onAppClose() {
    await this.telegram.close();
    await this.secretary.close();
  }
}
