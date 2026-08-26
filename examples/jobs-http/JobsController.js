import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { HttpError } from '../../lib/framework/errors.js';
import SumJob from './SumJob.js';

function validateValues(ctx, next) {
  const values = ctx.body?.values;
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
    throw new HttpError(422, { body: { error: 'values must be finite numbers' } });
  }
  ctx.state.values = values;
  return next();
}

function markSumOperation(ctx, next) {
  ctx.state.operation = 'sum';
  return next();
}

export class JobsController extends HttpControllerBase {
  static prefix = '/jobs';
  static middleware = [validateValues];
  static routes = [
    { method: 'POST', path: '/sum', handler: 'sum', middleware: [markSumOperation] },
  ];

  async sum(ctx) {
    const result = await this.jobRunner.run(
      SumJob,
      { values: ctx.state.values },
      {
        signal: ctx.signal,
        timeout: 5_000,
      },
    );
    return { status: 200, body: result };
  }
}
