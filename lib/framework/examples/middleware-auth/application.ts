import { Application } from '@daevox/framework';
import { AuthController } from './AuthController.ts';
import { authenticateBearer } from './authMiddleware.ts';

export function createAuthApplication() {
  const application = new Application({
    http: { middleware: [authenticateBearer] },
  });
  application.registerHttpController(AuthController);
  return application;
}
