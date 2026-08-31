import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createAuthApplication } from './application.ts';

interface TestResponse {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

function request(address: AddressInfo, path: string, token?: string): Promise<TestResponse> {
  return new Promise<TestResponse>((resolve, reject) => {
    const clientRequest = http.request(
      {
        host: address.address,
        port: address.port,
        path,
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        });
      },
    );
    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

test('middleware разрешает административный маршрут только роли admin', async () => {
  const application = createAuthApplication();
  const address = await application.listen({ port: 0 });

  try {
    const anonymous = await request(address, '/auth/profile');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers['www-authenticate'], 'Bearer realm="middleware-auth-example"');
    assert.deepEqual(anonymous.body, { error: 'UNAUTHENTICATED' });

    const unknownToken = await request(address, '/auth/profile', 'unknown-token');
    assert.equal(unknownToken.status, 401);
    assert.deepEqual(unknownToken.body, { error: 'UNAUTHENTICATED' });

    const profile = await request(address, '/auth/profile', 'user-token');
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body, {
      auth: { subjectId: 'user-42', roles: ['user'] },
    });

    const forbidden = await request(address, '/auth/admin', 'user-token');
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.body, { error: 'FORBIDDEN', requiredRole: 'admin' });

    const admin = await request(address, '/auth/admin', 'admin-token');
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body, {
      message: 'Administrative access granted',
      auth: { subjectId: 'admin-7', roles: ['user', 'admin'] },
    });
  } finally {
    await application.close();
  }
});
