import { Application } from '../../lib/framework/Application.js';
import { AuthController } from './AuthController.js';
import { authenticateBearer } from './authMiddleware.js';

export function createAuthApplication() {
  const application = new Application({
    http: { middleware: [authenticateBearer] },
  });
  application.registerHttpController(AuthController);
  return application;
}
