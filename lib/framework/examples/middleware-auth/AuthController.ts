import { HttpControllerBase } from '@daevox/framework';
import { requireAuthentication, requireRole } from './authMiddleware.ts';

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
  ];

  profile(_appState: any, ctx: any) {
    return { status: 200, body: { auth: ctx.state.auth } };
  }

  admin(_appState: any, ctx: any) {
    return {
      status: 200,
      body: { message: 'Administrative access granted', auth: ctx.state.auth },
    };
  }
}
