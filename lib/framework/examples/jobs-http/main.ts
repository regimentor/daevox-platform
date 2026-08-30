class TestAppState {
  readonly marker = undefined;
}
import { randomUUID } from 'node:crypto';
import { Application } from '@daevox/framework';
import { JobsController } from './JobsController.ts';

const application = new Application({
  appState: TestAppState,
  http: {
    middleware: [
      async (_appState: any, ctx: any, next: any) => {
        ctx.state.requestId = randomUUID();
        const response = await next();
        response.headers ??= new Headers();
        response.headers.set('x-request-id', ctx.state.requestId);
        return response;
      },
    ],
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
