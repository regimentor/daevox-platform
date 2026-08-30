import { Application } from '@daevox/framework';
import { HealthcheckController } from './http-controllers/healthcheck.controller.ts';
import { AuthController } from './http-controllers/auth.controller.ts';
import { DialogsController } from './http-controllers/dialogs.controller.ts';

export function createApplication() {
  const application = new Application({
    http: {
      onError(e) {
        console.error(e);
      },
    },
  });
  application.registerHttpController(HealthcheckController);
  application.registerHttpController(AuthController);
  application.registerHttpController(DialogsController);
  return application;
}
