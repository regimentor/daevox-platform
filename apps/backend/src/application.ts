import { Application } from '@daevox/framework';
import { HealthcheckController } from './http-controllers/healthcheck.controller.ts';

export function createApplication() {
  const application = new Application();
  application.registerHttpController(HealthcheckController);
  return application;
}
