import { Application } from '../../lib/framework/Application.js';
import { EventsController } from './EventsController.js';
import { JwtController } from './JwtController.js';
import { authentication } from './jwtAuthentication.js';

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

application.registerHttpController(JwtController);
application.registerWebSocketController(EventsController);

const address = await application.listen({ host: '127.0.0.1', port: 3000 });
console.log(`JWT authentication example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
