class TestAppState {
  readonly marker = undefined;
}
import { Application } from '@daevox/framework';
import { AuthController } from './AuthController.ts';
import { authenticateBearer } from './authMiddleware.ts';

export function createAuthApplication() {
  const application = new Application({
    appState: TestAppState,
    http: { middleware: [authenticateBearer] },
  });
  application.registerHttpController(AuthController);
  return application;
}
