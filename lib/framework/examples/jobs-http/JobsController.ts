import {
  HttpControllerBase,
  HttpError,
  type HttpRequestContext,
  type HttpResponse,
} from '@daevox/framework';
import type { ExampleAppState } from '../ExampleAppState.ts';
import SumJob, { type SumJobPayload } from './SumJob.ts';

type HttpNext = () => Promise<HttpResponse>;

function finiteValues(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry: unknown) => Number.isFinite(entry));
}

function valuesFromBody(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'values' in body ? body.values : undefined;
}

function validateValues(
  _appState: ExampleAppState,
  ctx: HttpRequestContext<unknown>,
  next: HttpNext,
): HttpResponse | Promise<HttpResponse> {
  const values = valuesFromBody(ctx.body);
  if (!finiteValues(values)) {
    throw new HttpError(422, {
      body: { error: 'values must be finite numbers' },
    });
  }
  ctx.state.values = values;
  return next();
}

function markSumOperation(
  _appState: ExampleAppState,
  ctx: HttpRequestContext<unknown>,
  next: HttpNext,
): Promise<HttpResponse> {
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
  ] as const;

  async sum(_appState: ExampleAppState, ctx: HttpRequestContext<unknown>) {
    if (!finiteValues(ctx.state.values)) {
      throw new HttpError(500, { body: { error: 'Validated values are unavailable' } });
    }
    const payload: SumJobPayload = { values: ctx.state.values };
    const result = await this.jobRunner.run(SumJob, payload, {
      signal: ctx.signal,
      timeout: 5_000,
    });
    return { status: 200, body: result };
  }
}
