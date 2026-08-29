import { Application, HttpError } from '@daevox/framework';
import { BroadcastController } from './BroadcastController.ts';
import { BrowserController } from './BrowserController.ts';
import { EventsController } from './EventsController.ts';

/**
 * Creates the WebSocket server-push example application.
 * Создаёт демонстрационное приложение WebSocket server push.
 *
 * @returns Configured application. / Настроенное приложение.
 * @public
 */
export function createWebSocketApplication() {
  const application = new Application({
    websocket: {
      middleware: [
        (ctx: any, next: any) => {
          ctx.state.messageCount = (ctx.state.messageCount ?? 0) + 1;
          return next();
        },
      ],
      onConnect(ctx: any) {
        if (ctx.query.get('token') !== 'demo') {
          throw new HttpError(401, { body: { error: 'Unauthorized' } });
        }
        ctx.state.auth = { subjectId: 'example-user' };
        return 'example-client';
      },
      onError(error: any) {
        console.error(error);
      },
    },
  });

  application.registerHttpController(BrowserController);
  application.registerHttpController(BroadcastController);
  application.registerWebSocketController(EventsController);
  return application;
}
