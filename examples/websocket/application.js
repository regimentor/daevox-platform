import { Application } from '../../lib/framework/Application.js';
import { HttpError } from '../../lib/framework/errors.js';
import { BroadcastController } from './BroadcastController.js';
import { BrowserController } from './BrowserController.js';
import { EventsController } from './EventsController.js';

/**
 * Creates the WebSocket server-push example application.
 * Создаёт демонстрационное приложение WebSocket server push.
 *
 * @returns {Application} Configured application. / Настроенное приложение.
 * @public
 */
export function createWebSocketApplication() {
  const application = new Application({
    websocket: {
      middleware: [
        (ctx, next) => {
          ctx.state.messageCount = (ctx.state.messageCount ?? 0) + 1;
          return next();
        },
      ],
      onConnect(ctx) {
        if (ctx.query.get('token') !== 'demo') {
          throw new HttpError(401, { body: { error: 'Unauthorized' } });
        }
        ctx.state.auth = { subjectId: 'example-user' };
        return 'example-client';
      },
      onError(error) {
        console.error(error);
      },
    },
  });

  application.registerHttpController(BrowserController);
  application.registerHttpController(BroadcastController);
  application.registerWebSocketController(EventsController);
  return application;
}
