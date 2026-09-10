import { Application } from '@daevox/framework';
import { SummaryScheduledTask } from './tasks/summary.scheduled-task.ts';
import { SecretaryRefreshTask } from './tasks/secretary-refresh.scheduled-task.ts';
import { AppState } from './app-state.ts';
import { HealthcheckController } from './http-controllers/healthcheck.controller.ts';
import { TelegramController } from './http-controllers/telegram.controller.ts';
import { localMiddleware } from './middlewares/local.middleware.ts';
import { SecretaryController } from './http-controllers/secretary.controller.ts';

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
  application.registerHttpController(SecretaryController);
  application.registerScheduledTask(SummaryScheduledTask);
  application.registerScheduledTask(SecretaryRefreshTask);
  return application;
}
