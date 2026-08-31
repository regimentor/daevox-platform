import { HttpControllerBase, HttpError, type HttpRequestContext } from '@daevox/framework';
import type { ExampleAppState } from '../ExampleAppState.ts';
import { OrderCreated } from './OrderCreated.ts';

function orderIdFrom(body: unknown): string {
  if (
    body === null ||
    typeof body !== 'object' ||
    !('orderId' in body) ||
    typeof body.orderId !== 'string' ||
    body.orderId === ''
  ) {
    throw new HttpError(422, { body: { error: 'orderId must be a non-empty string' } });
  }
  return body.orderId;
}

export class OrdersController extends HttpControllerBase {
  static prefix = '/orders';
  static routes = [{ method: 'POST', path: '/', handler: 'create' }] as const;

  create(_appState: ExampleAppState, ctx: HttpRequestContext<unknown>) {
    const event = new OrderCreated(orderIdFrom(ctx.body));
    this.events.push({ listener: 'audit', event: 'OrderCreated' }, event);
    return { status: 202, body: { orderId: event.orderId, accepted: true } };
  }
}
