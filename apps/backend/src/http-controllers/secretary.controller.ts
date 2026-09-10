import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import {
  isObservationCommand,
  isResumeCommand,
  isAutoReplyCommand,
} from '@daevox/telegram-contract/secretary';
import type { AppState } from '../app-state.ts';

const validId = (value: string | null) =>
  value !== null && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));

export class SecretaryController extends HttpControllerBase {
  static prefix = '/api/secretary';
  static routes = [
    { method: 'GET', path: '/state', handler: 'state' },
    { method: 'GET', path: '/chats', handler: 'chats' },
    { method: 'GET', path: '/history', handler: 'history' },
    { method: 'GET', path: '/summary', handler: 'summary' },
    { method: 'POST', path: '/summary', handler: 'summarize' },
    { method: 'GET', path: '/daily-summaries', handler: 'dailySummaries' },
    { method: 'POST', path: '/daily-summaries', handler: 'retryDailySummary' },
    { method: 'POST', path: '/observation', handler: 'observation' },
    { method: 'POST', path: '/auto-reply', handler: 'autoReply' },
    { method: 'POST', path: '/resume', handler: 'resume' },
    ...[
      'auto-reply',
      'state',
      'chats',
      'history',
      'summary',
      'daily-summaries',
      'observation',
      'resume',
    ].map((path) => ({
      method: 'OPTIONS',
      path: `/${path}`,
      handler: 'options' as const,
    })),
  ] as const;
  state(app: AppState) {
    return { status: 200, body: app.secretary.snapshot() };
  }
  options() {
    return { status: 204 };
  }
  dailySummaries(app: AppState, ctx: HttpRequestContext) {
    try {
      const accountId = ctx.query.get('accountId'),
        chatId = ctx.query.get('chatId');
      if (!validId(accountId) || !validId(chatId)) throw new Error('invalid');
      const before = ctx.query.get('before');
      const limit = Number(ctx.query.get('limit') ?? 10);
      if (
        (before !== null && !/^\d{4}-\d{2}-\d{2}$/.test(before)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        throw new Error('invalid');
      return {
        status: 200,
        body: app.secretary.dailySummary(accountId!, chatId!, undefined, { before, limit }),
      };
    } catch (error) {
      return this.error(error);
    }
  }
  async retryDailySummary(app: AppState, ctx: HttpRequestContext) {
    try {
      const body: unknown = await this.body(ctx);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
      const value = body as Record<string, unknown>;
      if (
        typeof value.accountId !== 'string' ||
        !validId(value.accountId) ||
        typeof value.chatId !== 'string' ||
        !validId(value.chatId) ||
        typeof value.day !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
      )
        throw new Error('invalid');
      return {
        status: 202,
        body: app.secretary.dailySummary(value.accountId, value.chatId, value.day),
      };
    } catch (error) {
      return this.error(error);
    }
  }
  summary(app: AppState, ctx: HttpRequestContext) {
    try {
      const accountId = ctx.query.get('accountId');
      const chatId = ctx.query.get('chatId');
      const scope = ctx.query.get('scope') ?? 'all';
      if (!validId(accountId) || !validId(chatId) || (scope !== 'all' && scope !== 'latest'))
        return { status: 400, body: { error: 'invalid_request' } };
      return { status: 200, body: app.secretary.summary(accountId!, chatId!, scope) };
    } catch (error) {
      return this.error(error);
    }
  }
  async summarize(app: AppState, ctx: HttpRequestContext) {
    try {
      const body: unknown = await this.body(ctx);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
      const value = body as Record<string, unknown>;
      if (
        Object.keys(value).some((key) => !['accountId', 'chatId', 'scope'].includes(key)) ||
        typeof value.accountId !== 'string' ||
        !validId(value.accountId) ||
        typeof value.chatId !== 'string' ||
        !validId(value.chatId) ||
        (value.scope !== 'all' && value.scope !== 'latest')
      )
        throw new Error('invalid');
      return {
        status: 202,
        body: app.secretary.summary(value.accountId, value.chatId, value.scope, true),
      };
    } catch (error) {
      return this.error(error);
    }
  }
  history(app: AppState, ctx: HttpRequestContext) {
    try {
      const accountId = ctx.query.get('accountId');
      const chatId = ctx.query.get('chatId');
      const before = ctx.query.get('before');
      const limit = Number(ctx.query.get('limit') ?? 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid');
      if (!validId(accountId) || !validId(chatId) || (before !== null && !validId(before)))
        return { status: 400, body: { error: 'invalid_request' } };
      return {
        status: 200,
        body: app.secretary.history(
          accountId!,
          chatId!,
          ctx.query.get('scope') !== 'all',
          before,
          limit,
        ),
      };
    } catch (error) {
      return this.error(error);
    }
  }
  async chats(app: AppState, ctx: HttpRequestContext) {
    if (app.secretary.snapshot().storage === 'error')
      return { status: 503, body: { error: 'storage_error' } };
    const query = ctx.query;
    return {
      status: 200,
      body: app.secretary.chatsPage(
        query.get('q') ?? '',
        (query.get('filter') as 'all' | 'observed' | 'archived') ?? 'all',
        Number(query.get('limit') ?? 50),
      ),
    };
  }
  private async body(ctx: HttpRequestContext) {
    if (ctx.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new Error('invalid');
    return ctx.requestBody.json();
  }
  async autoReply(app: AppState, ctx: HttpRequestContext) {
    try {
      const value: unknown = await this.body(ctx);
      if (!isAutoReplyCommand(value)) return { status: 400, body: { error: 'invalid_request' } };
      const chat = app.secretary.setAutoReply(
        value.accountId,
        value.chatId,
        value.enabled,
        value.expected,
      );
      return { status: 200, body: { context: app.secretary.snapshot().context, chat } };
    } catch (error) {
      return this.error(error);
    }
  }
  async observation(app: AppState, ctx: HttpRequestContext) {
    try {
      const value: unknown = await this.body(ctx);
      if (!isObservationCommand(value)) return { status: 400, body: { error: 'invalid_request' } };
      return {
        status: 200,
        body: {
          context: app.secretary.snapshot().context,
          chat: app.secretary.setObservation(
            value.accountId,
            value.chatId,
            value.enabled,
            value.expected,
          ),
        },
      };
    } catch (error) {
      return this.error(error);
    }
  }
  async resume(app: AppState, ctx: HttpRequestContext) {
    try {
      const value: unknown = await this.body(ctx);
      if (!isResumeCommand(value)) return { status: 400, body: { error: 'invalid_request' } };
      return {
        status: 200,
        body: {
          context: app.secretary.snapshot().context,
          chat: app.secretary.resume(value.accountId, value.chatId, value.expected),
        },
      };
    } catch (error) {
      return this.error(error);
    }
  }
  private error(error: unknown) {
    const code = (error as { code?: string })?.code;
    return {
      status:
        code === 'not_found'
          ? 404
          : code === 'stale'
            ? 409
            : code === 'storage'
              ? 503
              : code === 'busy'
                ? 429
                : code === 'empty'
                  ? 422
                  : 400,
      body: { error: code ?? 'invalid_request' },
    };
  }
}
