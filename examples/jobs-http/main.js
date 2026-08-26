import { randomUUID } from 'node:crypto';
import { Application } from '../../lib/framework/Application.js';
import { JobsController } from './JobsController.js';

const application = new Application({
  http: {
    middleware: [
      async (ctx, next) => {
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
