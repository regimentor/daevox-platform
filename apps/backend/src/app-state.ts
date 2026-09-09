import type { AppStateInstance } from '@daevox/framework';
import { TelegramConnection } from './telegram/connection.ts';
import { telegramParameters } from './telegram/config.ts';

export class AppState implements AppStateInstance {
  readonly telegram: TelegramConnection;
  readonly webClientOrigin: string;

  constructor(
    telegram = new TelegramConnection({ parameters: telegramParameters(process.env) }),
    webClientOrigin = process.env.WEB_CLIENT_ORIGIN ?? 'http://127.0.0.1:5173',
  ) {
    this.telegram = telegram;
    this.webClientOrigin = webClientOrigin;
  }
  onAppStart() {
    void this.telegram.start();
  }
  async onAppClose() {
    await this.telegram.close();
  }
}
