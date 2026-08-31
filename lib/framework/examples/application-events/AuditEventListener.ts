import { EventListenerBase, type ApplicationEventContext } from '@daevox/framework';
import { OrderCreated } from './OrderCreated.ts';

export class AuditEventListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'orderCreated' }] as const;

  orderCreated(data: OrderCreated, _context: ApplicationEventContext): void {
    console.log(`Audit event: order ${data.orderId} was created`);
  }
}
