import { Application, type ApplicationEventAddress } from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';
import { AuditEventListener } from './AuditEventListener.ts';
import { OrdersController } from './OrdersController.ts';

const application = new Application({
  appState: ExampleAppState,
  events: {
    onError(error: unknown, context: ApplicationEventAddress) {
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
