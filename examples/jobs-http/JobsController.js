import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { HttpError } from '../../lib/framework/errors.js';
import SumJob from './SumJob.js';

export class JobsController extends HttpControllerBase {
  static prefix = '/jobs';
  static routes = [{ method: 'POST', path: '/sum', handler: 'sum' }];

  async sum(ctx) {
    const values = ctx.body?.values;
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
      throw new HttpError(422, { body: { error: 'values must be finite numbers' } });
    }
    const result = await this.jobRunner.run(SumJob, ctx.body, {
      signal: ctx.signal,
      timeout: 5_000,
    });
    return { status: 200, body: result };
  }
}
