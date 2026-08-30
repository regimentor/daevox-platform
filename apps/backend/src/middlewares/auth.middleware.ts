import { HttpError, type HttpRequestContext, type HttpResponse } from '@daevox/framework';
import { verifyToken } from '../services/jwt.service.ts';

export async function authMiddleware(ctx: HttpRequestContext, next: () => Promise<HttpResponse>) {
  const { headers } = ctx;
  const authHeader = headers.get('Authorization');
  if (!authHeader) {
    throw new HttpError(400, { body: 'No Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    throw new HttpError(400, { body: 'No token' });
  }

  const decoded = await verifyToken(token);

  ctx.state.login = decoded.login;

  return next();
}
