import { HttpControllerBase, HttpError, type HttpRequestContext } from '@daevox/framework';
import { AppState } from '../app-state.ts';
import { createToken } from '../services/jwt.service.ts';
import { schema } from '@daevox/db';
import { eq } from 'drizzle-orm';

export class AuthController extends HttpControllerBase {
  static prefix = '/auth';
  static routes = [
    {
      method: 'POST',
      path: '/login',
      handler: 'login',
    },
  ] as const;

  async login(_appState: AppState, ctx: HttpRequestContext) {
    const { body } = ctx;
    if (!body) {
      throw new HttpError(400, { body: 'No body' });
    }

    const { login } = body;
    if (!login) {
      throw new HttpError(400, { body: 'No login' });
    }

    const loginExists = await _appState
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, login));

    if (!loginExists) {
      throw new HttpError(404, { body: 'Login does not exist' });
    }

    const token = await createToken(login, _appState.getConfig().JWT_SECRET);

    return { status: 200, body: { token } };
  }
}
