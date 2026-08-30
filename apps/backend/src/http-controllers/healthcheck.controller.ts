import { HttpControllerBase } from '@daevox/framework';
import { schema } from '@daevox/db';
import { completionService } from '../services/completion.service.ts';
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
    const dbStatus = await this.#db.select().from(schema.usersTable);

    return { status: 200, body: { status: 'ok', dbStatus } };
  }

  async check() {
    const response = await completionService.complete('Привет как дела?');

    console.log(response);

    return { status: 200, body: { status: 'ok', response } };
  }
}
