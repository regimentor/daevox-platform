import {
  WebSocketControllerBase,
  WebSocketEventError,
  type WebSocketHandlerContext,
  type WebSocketMessageMiddleware,
} from '@daevox/framework';
import type { ExampleAppState } from '../ExampleAppState.ts';

const requireAuthentication: WebSocketMessageMiddleware<ExampleAppState> = (
  _appState,
  ctx,
  next,
) => {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
};

function messageFrom(body: unknown): string {
  if (
    body === null ||
    typeof body !== 'object' ||
    !('message' in body) ||
    typeof body.message !== 'string' ||
    body.message.trim() === ''
  ) {
    throw new WebSocketEventError('INVALID_INPUT');
  }
  return body.message;
}

const requireMessage: WebSocketMessageMiddleware<ExampleAppState> = (_appState, ctx, next) => {
  messageFrom(ctx.body);
  return next();
};

export class EventsController extends WebSocketControllerBase {
  static name = 'events';
  static middleware = [requireAuthentication];
  static events = [{ name: 'echo', handler: 'echo', middleware: [requireMessage] }] as const;

  echo(_appState: ExampleAppState, ctx: WebSocketHandlerContext<unknown>) {
    return { message: messageFrom(ctx.body), messageCount: ctx.state.messageCount };
  }
}
