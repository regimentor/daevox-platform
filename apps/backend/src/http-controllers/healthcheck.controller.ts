import { HttpControllerBase } from '@daevox/framework';

export class HealthcheckController extends HttpControllerBase {
  static prefix = '/healthcheck';

  static routes = [{ method: 'GET', path: '/', handler: 'check' }];

  check() {
    return { status: 200, body: { status: 'ok' } };
  }
}
