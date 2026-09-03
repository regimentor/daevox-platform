import assert from 'node:assert/strict';
import test from 'node:test';

import { createHttpJsonBodyContractApplication } from './application.ts';

test('example materializes a valid body and rejects an invalid body', async () => {
  const application = createHttpJsonBodyContractApplication();
  const address = await application.listen({ port: 0 });
  const url = `http://${address.address}:${address.port}/users`;
  try {
    const valid = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        address: { street: 'Main' },
        aliases: ['ada'],
      }),
    });
    assert.equal(valid.status, 201);
    assert.deepEqual(await valid.json(), {
      className: 'CreateUserBody',
      name: 'Ada',
      street: 'Main',
      aliases: ['ada'],
    });

    const invalid = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', address: { street: '' }, aliases: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as any).code, 'INVALID_JSON_BODY');
  } finally {
    await application.close();
  }
});
