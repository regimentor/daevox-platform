import { createAuthApplication } from './application.ts';

const application = createAuthApplication();
const address = await application.listen({ port: 3000 });
console.log(`Middleware auth example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
