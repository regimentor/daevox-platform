import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static events = [{ name: 'echo', handler: 'echo' }];

  echo(ctx) {
    if (typeof ctx.body.message !== 'string' || ctx.body.message.trim() === '') return;
    return { message: ctx.body.message };
  }
}
