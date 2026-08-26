import { Application } from '../../lib/framework/Application.js';
import { HttpError } from '../../lib/framework/errors.js';
import { BrowserController } from './BrowserController.js';
import { EventsController } from './EventsController.js';

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
    },
    onError(error) {
      console.error(error);
    },
  },
});

application.registerHttpController(BrowserController);
application.registerWebSocketController(EventsController);

const address = await application.listen({ port: 3000 });
console.log(`WebSocket example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
