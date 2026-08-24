import { Application } from '../../lib/framework/Application.js';
import { BrowserController } from './BrowserController.js';
import { EventsController } from './EventsController.js';

const application = new Application({
  websocket: {
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
