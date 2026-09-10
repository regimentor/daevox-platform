import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TdlibClient } from '../src/index.ts';

test('real TDLib answers an offline request through FFI', async () => {
  const client = new TdlibClient();
  await client.start();
  try {
    const result = await client.invoke({ '@type': 'testCallEmpty' });
    assert.equal(result['@type'], 'ok');
  } finally {
    await client.close();
  }
});
