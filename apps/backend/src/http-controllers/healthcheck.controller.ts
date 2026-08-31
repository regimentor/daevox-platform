import { HttpControllerBase } from '@daevox/framework';
import { schema } from '@daevox/db';
import { AppState } from '../app-state.ts';

export class HealthcheckController extends HttpControllerBase {
  static prefix = '/healthcheck';

  static routes = [
    { method: 'GET', path: '/', handler: 'check' },
    { method: 'GET', path: '/db', handler: 'checkDb' },
  ] as const;

  async checkDb(_appState: AppState) {
    const dbStatus = await _appState.getDb().select().from(schema.users);

    return { status: 200, body: { status: 'ok', dbStatus } };
  }

  async check() {
    return { status: 200, body: { status: 'ok' } };
  }
}
