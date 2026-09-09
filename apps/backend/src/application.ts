import { Application } from '@daevox/framework';
import { AppState } from './app-state.ts';
import { HealthcheckController } from './http-controllers/healthcheck.controller.ts';
import { TelegramController } from './http-controllers/telegram.controller.ts';
import { localMiddleware } from './middlewares/local.middleware.ts';

export function createApplication(appState: new () => AppState = AppState) {
  const application = new Application({
    appState,
    http: {
      bodyLimit: '16KiB',
      middleware: [localMiddleware],
      onError() {
        console.error('Backend HTTP request failed');
      },
    },
  });
  application.registerHttpController(HealthcheckController);
  application.registerHttpController(TelegramController);
  return application;
}
