import { HttpControllerBase } from '@daevox/framework';
import { schema } from '@daevox/db';
import { AppState } from '../app-state.ts';

export class HealthcheckController extends HttpControllerBase {
  static prefix = '/healthcheck';

  static routes = [
    { method: 'GET', path: '/', handler: 'check' },
    { method: 'GET', path: '/db', handler: 'checkDb' },
  ];

  #db: ReturnType<typeof AppState.instance.getDb>;

  constructor(...args: any[]) {
    super(...args);

    this.#db = AppState.instance.getDb();
  }

  async checkDb() {
    const dbStatus = await this.#db.select().from(schema.users);

    return { status: 200, body: { status: 'ok', dbStatus } };
  }

  async check() {
    return { status: 200, body: { status: 'ok' } };
  }
}
