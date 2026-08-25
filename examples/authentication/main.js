import { Application } from '../../lib/framework/Application.js';
import { AuthenticationController } from './AuthenticationController.js';
import { EventsController } from './EventsController.js';
import { authentication } from './authentication.js';

const application = new Application({
  authentication,
  http: { bodyLimit: 16 * 1024 },
  websocket: {
    authentication: 'webSocket',
    allowedOrigins: ['http://127.0.0.1:3000'],
    onError(error) {
      console.error(error);
    },
  },
});

application.registerHttpController(AuthenticationController);
application.registerWebSocketController(EventsController);

const address = await application.listen({ host: '127.0.0.1', port: 3000 });
console.log(`Authentication example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
