import { createRuntimeRegistrationApplication } from './application.ts';

const application = createRuntimeRegistrationApplication();
const address = await application.listen({ port: 3000 });

console.log(`Runtime resources listening on http://${address.address}:${address.port}`);
console.log(`POST /runtime/register to register HTTP, WebSocket and event resources`);
console.log(`HTTP after registration: GET /runtime/status, POST /runtime/event`);
console.log(`WebSocket: /websocket, controller runtime, event ping`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
  });
}
