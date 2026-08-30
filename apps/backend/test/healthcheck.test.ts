import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApplication } from '../src/application.ts';

const application = createApplication();
let baseUrl: string;

before(async () => {
  const address = await application.listen({ port: 0 });
  baseUrl = `http://${address.address}:${address.port}`;
});

after(async () => {
  await application.close();
});

test('GET /healthcheck reports that the backend is healthy', async () => {
  const response = await fetch(`${baseUrl}/healthcheck`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
