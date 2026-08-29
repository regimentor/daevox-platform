import { Application } from '../../lib/framework/Application.ts';
import { AuthController } from './AuthController.ts';
import { authenticateBearer } from './authMiddleware.ts';

export function createAuthApplication() {
  const application = new Application({
    http: { middleware: [authenticateBearer] },
  });
  application.registerHttpController(AuthController);
  return application;
}
