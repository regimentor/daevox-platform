import { HttpControllerBase, HttpError } from '@daevox/framework';
import SumJob from './SumJob.ts';

function validateValues(ctx: any, next: any) {
  const values = ctx.body?.values;
  if (!Array.isArray(values) || values.some((value: any) => !Number.isFinite(value))) {
    throw new HttpError(422, {
      body: { error: 'values must be finite numbers' },
    });
  }
  ctx.state.values = values;
  return next();
}

function markSumOperation(ctx: any, next: any) {
  ctx.state.operation = 'sum';
  return next();
}

export class JobsController extends HttpControllerBase {
  static prefix = '/jobs';
  static middleware = [validateValues];
  static routes = [
    {
      method: 'POST',
      path: '/sum',
      handler: 'sum',
      middleware: [markSumOperation],
    },
  ];

  async sum(ctx: any) {
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
