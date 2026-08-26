import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import { WebSocketEventError } from '../../lib/framework/errors.js';

function requireAuthentication(ctx, next) {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
}

function requireMessage(ctx, next) {
  if (typeof ctx.body.message !== 'string' || ctx.body.message.trim() === '') {
    throw new WebSocketEventError('INVALID_INPUT');
  }
  return next();
}

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static middleware = [requireAuthentication];
  static events = [{ name: 'echo', handler: 'echo', middleware: [requireMessage] }];

  echo(ctx) {
    return { message: ctx.body.message, messageCount: ctx.state.messageCount };
  }
}
