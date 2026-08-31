import { randomUUID } from 'node:crypto';
import { Application, type HttpMiddleware, type HttpResponse } from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';
import { JobsController } from './JobsController.ts';

function copyHeaders(value: HttpResponse['headers']): Headers {
  if (value instanceof Headers) return new Headers(value);
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value ?? {})) {
    if (Array.isArray(headerValue)) {
      for (const item of headerValue) headers.append(name, item);
    } else {
      headers.set(name, headerValue);
    }
  }
  return headers;
}

const requestIdMiddleware: HttpMiddleware<ExampleAppState> = async (_appState, ctx, next) => {
  const requestId = randomUUID();
  ctx.state.requestId = requestId;
  const response = await next();
  const headers = copyHeaders(response.headers);
  headers.set('x-request-id', requestId);
  response.headers = headers;
  return response;
};

const application = new Application({
  appState: ExampleAppState,
  http: {
    middleware: [requestIdMiddleware],
  },
});
application.registerHttpController(JobsController);
const address = await application.listen({ port: 3000 });
console.log(`Jobs HTTP example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
