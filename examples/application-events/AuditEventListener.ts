import { EventListenerBase } from '../../lib/framework/EventListenerBase.ts';
import { OrderCreated } from './OrderCreated.ts';

export class AuditEventListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'orderCreated' }];

  orderCreated(data: any) {
    console.log(`Audit event: order ${data.orderId} was created`);
  }
}
