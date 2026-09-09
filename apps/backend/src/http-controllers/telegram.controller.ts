import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import { isCommand, type Action } from '@daevox/telegram-contract';
import type { AppState } from '../app-state.ts';
import { CommandError, safeError } from '../telegram/connection.ts';

export class TelegramController extends HttpControllerBase {
  static prefix = '/api/telegram';
  static routes = [
    { method: 'GET', path: '/state', handler: 'state' },
    { method: 'POST', path: '/connect', handler: 'connect' },
    { method: 'POST', path: '/password', handler: 'password' },
    { method: 'POST', path: '/disconnect', handler: 'disconnect' },
    { method: 'POST', path: '/restart', handler: 'restart' },
    ...['state', 'connect', 'password', 'disconnect', 'restart'].map((path) => ({
      method: 'OPTIONS',
      path: `/${path}`,
      handler: 'options' as const,
    })),
  ] as const;
  state(app: AppState) {
    return { status: 200, body: app.telegram.snapshot() };
  }
  options() {
    return { status: 204 };
  }
  connect(app: AppState, ctx: HttpRequestContext) {
    return this.command(app, ctx, 'connect');
  }
  password(app: AppState, ctx: HttpRequestContext) {
    return this.command(app, ctx, 'submit_password');
  }
  disconnect(app: AppState, ctx: HttpRequestContext) {
    return this.command(app, ctx, 'disconnect');
  }
  restart(app: AppState, ctx: HttpRequestContext) {
    return this.command(app, ctx, 'restart');
  }
  private async command(app: AppState, ctx: HttpRequestContext, action: Action) {
    try {
      if (
        ctx.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      )
        return { status: 400, body: { error: safeError('invalid_request') } };
      const body: unknown = await ctx.requestBody.json();
      if (!isCommand(body, action))
        return { status: 400, body: { error: safeError('invalid_request') } };
      return { status: 202, body: app.telegram.accept(action, body) };
    } catch (error) {
      if (error instanceof CommandError)
        return { status: error.status, body: { error: error.detail } };
      return { status: 400, body: { error: safeError('invalid_request') } };
    }
  }
}
