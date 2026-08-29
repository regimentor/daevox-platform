import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { OrderCreated } from './OrderCreated.js';

export class OrdersController extends HttpControllerBase {
  static prefix = '/orders';
  static routes = [{ method: 'POST', path: '/', handler: 'create' }];

  create(ctx) {
    const event = new OrderCreated(ctx.body.orderId);
    this.events.push({ listener: 'audit', event: 'OrderCreated' }, event);
    return { status: 202, body: { orderId: event.orderId, accepted: true } };
  }
}
