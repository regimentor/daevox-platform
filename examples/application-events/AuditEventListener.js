import { EventListenerBase } from '../../lib/framework/EventListenerBase.js';
import { OrderCreated } from './OrderCreated.js';

export class AuditEventListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'orderCreated' }];

  orderCreated(data) {
    console.log(`Audit event: order ${data.orderId} was created`);
  }
}
