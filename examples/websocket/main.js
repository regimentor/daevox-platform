import { createWebSocketApplication } from './application.js';

const application = createWebSocketApplication();

const address = await application.listen({ port: 3000 });
console.log(`WebSocket example listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
