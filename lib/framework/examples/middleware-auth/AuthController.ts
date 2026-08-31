import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import type { ExampleAppState } from '../ExampleAppState.ts';
import { getAuthentication, requireAuthentication, requireRole } from './authMiddleware.ts';

export class AuthController extends HttpControllerBase {
  static prefix = '/auth';
  static middleware = [requireAuthentication];
  static routes = [
    { method: 'GET', path: '/profile', handler: 'profile' },
    {
      method: 'GET',
      path: '/admin',
      handler: 'admin',
      middleware: [requireRole('admin')],
    },
  ] as const;

  profile(_appState: ExampleAppState, ctx: HttpRequestContext<unknown>) {
    return { status: 200, body: { auth: getAuthentication(ctx) } };
  }

  admin(_appState: ExampleAppState, ctx: HttpRequestContext<unknown>) {
    return {
      status: 200,
      body: { message: 'Administrative access granted', auth: getAuthentication(ctx) },
    };
  }
}
