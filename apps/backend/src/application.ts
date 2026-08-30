import { Application } from '@daevox/framework';
import { HealthcheckController } from './http-controllers/healthcheck.controller.ts';

export function createApplication() {
  const application = new Application({
    http: {
      onError(e) {
        console.error(e);
      },
    },
  });
  application.registerHttpController(HealthcheckController);
  return application;
}
