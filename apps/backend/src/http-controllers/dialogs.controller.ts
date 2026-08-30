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
  ];

  #db: ReturnType<typeof AppState.instance.getDb>;

  constructor(...args: any[]) {
    super(...args);
    this.#db = AppState.instance.getDb();
  }

  async createDialog(_appState: any, ctx: HttpRequestContext) {
    const { login } = ctx.state as { login: string };
    const [user] = await this.#db.select().from(schema.users).where(eq(schema.users.login, login));
    if (!user) {
      return { status: 404, data: { message: 'User not found' } };
    }

    const dialog = await this.#db.insert(schema.dialogs).values({ userId: user.id });
    return { status: 200, data: { dialog: dialog } };
  }

  listDialogs() {
    const dialogs = this.#db.select().from(schema.dialogs);
    return { status: 200, data: { dialogs: dialogs } };
  }

  sendMessage() {}
}
