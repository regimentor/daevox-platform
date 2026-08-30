import { HttpControllerBase } from '@daevox/framework';
import { OrderCreated } from './OrderCreated.ts';

export class OrdersController extends HttpControllerBase {
  static prefix = '/orders';
  static routes = [{ method: 'POST', path: '/', handler: 'create' }];

  create(_appState: any, ctx: any) {
    const event = new OrderCreated(ctx.body.orderId);
    this.events.push({ listener: 'audit', event: 'OrderCreated' }, event);
    return { status: 202, body: { orderId: event.orderId, accepted: true } };
  }
}
