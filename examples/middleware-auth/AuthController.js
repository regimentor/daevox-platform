import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { requireAuthentication, requireRole } from './authMiddleware.js';

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

  profile(ctx) {
    return { status: 200, body: { auth: ctx.state.auth } };
  }

  admin(ctx) {
    return {
      status: 200,
      body: { message: 'Administrative access granted', auth: ctx.state.auth },
    };
  }
}
