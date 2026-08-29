import { Application } from '../../lib/framework/Application.js';
import { AuditEventListener } from './AuditEventListener.js';
import { OrdersController } from './OrdersController.js';

const application = new Application({
  events: {
    onError(error, context) {
      console.error(`Event ${context.listener}/${context.event} failed`, error);
    },
  },
});

application.registerEventListener(AuditEventListener);
application.registerHttpController(OrdersController);

const address = await application.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
  });
}
