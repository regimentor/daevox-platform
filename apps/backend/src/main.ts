import dotenv from 'dotenv';

dotenv.config({ path: '../../.env', debug: true });

import { AppState } from './app-state.ts';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new RangeError('PORT must be an integer between 0 and 65535');
}

const appState = new AppState();

console.log(appState.getConfig());

import { createApplication } from './application.ts';
const application = createApplication();
const address = await application.listen({ port, host: '0.0.0.0' });

console.log(`Backend listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
