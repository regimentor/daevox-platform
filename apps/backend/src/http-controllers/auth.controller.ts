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
  ];

  #db: ReturnType<typeof AppState.instance.getDb>;

  constructor(...args: any[]) {
    super(...args);
    this.#db = AppState.instance.getDb();
  }

  async login(_appState: any, ctx: HttpRequestContext) {
    const { body } = ctx;
    if (!body) {
      throw new HttpError(400, { body: 'No body' });
    }

    const { login } = body;
    if (!login) {
      throw new HttpError(400, { body: 'No login' });
    }

    const loginExists = await this.#db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, login));

    if (!loginExists) {
      throw new HttpError(404, { body: 'Login does not exist' });
    }

    const token = await createToken(login);

    return { status: 200, body: { token } };
  }
}
