import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApplication } from '../src/application.ts';
import { AppState } from '../src/app-state.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { testDatabase } from '@daevox/db/testing';

const database = testDatabase();
class State extends AppState {
  constructor() {
    super(new TelegramConnection({ parameters: null }), undefined, database.url);
  }
}
const application = createApplication(State);
let baseUrl: string;

before(async () => {
  const address = await application.listen({ port: 0 });
  baseUrl = `http://${address.address}:${address.port}`;
});

after(async () => {
  await application.close();
  database.cleanup();
});

test('GET /healthcheck reports that the backend is healthy', async () => {
  const response = await fetch(`${baseUrl}/healthcheck`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
