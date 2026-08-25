import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static events = [{ name: 'whoami', handler: 'whoami' }];

  whoami(ctx) {
    return { principal: ctx.authSession.principal };
  }
}
