import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static events = [{ name: 'ping', handler: 'ping' }];

  ping() {
    return { ok: true };
  }
}
