import { HttpError, type HttpMiddleware } from '@daevox/framework';
import { verifyToken } from '../services/jwt.service.ts';
import type { AppState } from '../app-state.ts';

export const authMiddleware: HttpMiddleware<AppState> = async (_appState, ctx, next) => {
  const { headers } = ctx;
  const authHeader = headers.get('Authorization');
  if (!authHeader) {
    throw new HttpError(400, { body: 'No Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    throw new HttpError(400, { body: 'No token' });
  }

  const decoded = await verifyToken(token, _appState.getConfig().JWT_SECRET);

  ctx.state.login = decoded.login;

  return next();
};
