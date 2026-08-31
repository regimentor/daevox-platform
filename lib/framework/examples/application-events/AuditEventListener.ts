import { EventListenerBase, type ApplicationEventContext } from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';
import { OrderCreated } from './OrderCreated.ts';

export class AuditEventListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'orderCreated' }] as const;

  orderCreated(
    appState: ExampleAppState,
    data: OrderCreated,
    _context: ApplicationEventContext,
  ): void {
    console.log(`Audit event: ${appState.constructor.name} order ${data.orderId} was created`);
  }
}
