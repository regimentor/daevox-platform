import {
  Application,
  HttpError,
  type WebSocketLifecycleContext,
  type WebSocketMessageMiddleware,
} from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';
import { BroadcastController } from './BroadcastController.ts';
import { BrowserController } from './BrowserController.ts';
import { EventsController } from './EventsController.ts';

const countMessages: WebSocketMessageMiddleware<ExampleAppState> = (_appState, ctx, next) => {
  const count = ctx.state.messageCount;
  ctx.state.messageCount = typeof count === 'number' ? count + 1 : 1;
  return next();
};

/**
 * Creates the WebSocket server-push example application.
 * Создаёт демонстрационное приложение WebSocket server push.
 *
 * @returns Configured application. / Настроенное приложение.
 * @public
 */
export function createWebSocketApplication() {
  const application = new Application({
    appState: ExampleAppState,
    websocket: {
      middleware: [countMessages],
      onConnect(_appState: ExampleAppState, ctx: WebSocketLifecycleContext) {
        if (ctx.query.get('token') !== 'demo') {
          throw new HttpError(401, { body: { error: 'Unauthorized' } });
        }
        ctx.state.auth = { subjectId: 'example-user' };
        return 'example-client';
      },
      onError(_appState: ExampleAppState, error: unknown) {
        console.error(error);
      },
    },
  });

  application.registerHttpController(BrowserController);
  application.registerHttpController(BroadcastController);
  application.registerWebSocketController(EventsController);
  return application;
}
