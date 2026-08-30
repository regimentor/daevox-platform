import { WebSocketControllerBase, WebSocketEventError } from '@daevox/framework';

function requireAuthentication(_appState: any, ctx: any, next: any) {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
}

function requireMessage(_appState: any, ctx: any, next: any) {
  if (typeof ctx.body.message !== 'string' || ctx.body.message.trim() === '') {
    throw new WebSocketEventError('INVALID_INPUT');
  }
  return next();
}

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static middleware = [requireAuthentication];
  static events = [{ name: 'echo', handler: 'echo', middleware: [requireMessage] }];

  echo(_appState: any, ctx: any) {
    return { message: ctx.body.message, messageCount: ctx.state.messageCount };
  }
}
