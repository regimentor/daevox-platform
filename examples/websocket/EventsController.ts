import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.ts';
import { WebSocketEventError } from '../../lib/framework/errors.ts';

function requireAuthentication(ctx: any, next: any) {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
}

function requireMessage(ctx: any, next: any) {
  if (typeof ctx.body.message !== 'string' || ctx.body.message.trim() === '') {
    throw new WebSocketEventError('INVALID_INPUT');
  }
  return next();
}

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static middleware = [requireAuthentication];
  static events = [{ name: 'echo', handler: 'echo', middleware: [requireMessage] }];

  echo(ctx: any) {
    return { message: ctx.body.message, messageCount: ctx.state.messageCount };
  }
}
