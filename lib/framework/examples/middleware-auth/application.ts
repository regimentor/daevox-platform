import { Application } from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';
import { AuthController } from './AuthController.ts';
import { authenticateBearer } from './authMiddleware.ts';

export function createAuthApplication() {
  const application = new Application({
    appState: ExampleAppState,
    http: { middleware: [authenticateBearer] },
  });
  application.registerHttpController(AuthController);
  return application;
}
