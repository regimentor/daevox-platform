import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import { AppState } from '../app-state.ts';
import { schema } from '@daevox/db';
import { authMiddleware } from '../middlewares/auth.middleware.ts';
import { eq } from 'drizzle-orm';

export class DialogsController extends HttpControllerBase {
  static prefix = '/dialogs';

  static middleware = [authMiddleware];

  static routes = [
    {
      path: '/',
      method: 'GET',
      handler: 'listDialogs',
    },
    {
      path: '/:id',
      method: 'POST',
      handler: 'sendMessage',
    },
  ] as const;

  async createDialog(_appState: AppState, ctx: HttpRequestContext<{ login: string }>) {
    if (!ctx.body) return { status: 400, data: { message: 'Body is required' } };
    const { login } = ctx.body;
    const [user] = await _appState
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, login));
    if (!user) {
      return { status: 404, data: { message: 'User not found' } };
    }

    const dialog = await _appState.getDb().insert(schema.dialogs).values({ userId: user.id });
    return { status: 200, data: { dialog: dialog } };
  }

  listDialogs(_appState: AppState) {
    const dialogs = _appState.getDb().select().from(schema.dialogs);
    return { status: 200, data: { dialogs: dialogs } };
  }

  sendMessage() {
    return { status: 200, data: { message: 'Message sent' } };
  }
}
