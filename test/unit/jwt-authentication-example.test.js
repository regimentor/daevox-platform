import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { JwtAuthority } from '../../examples/jwt-authentication/JwtAuthority.js';

test('JWT example выпускает, проверяет и отзывает HS256 token', () => {
  const authority = new JwtAuthority(randomBytes(32));
  const principal = { id: 'user-1', email: 'demo@example.com' };
  const issued = authority.issue(principal);
  const session = authority.verify(issued.token);

  assert.deepEqual(session.principal, principal);
  assert.equal(session.expiresAt, issued.expiresAt);
  assert.equal(authority.isActive(session), true);
  assert.equal(authority.revoke(session), true);
  assert.equal(authority.verify(issued.token), null);
  assert.equal(authority.isActive(session), false);
});

test('JWT example отклоняет подмену payload, signature и algorithm', () => {
  const authority = new JwtAuthority(randomBytes(32));
  const { token } = authority.issue({ id: 'user-1', email: 'demo@example.com' });
  const [header, payload, signature] = token.split('.');
  const changedPayload = Buffer.from(
    JSON.stringify({ iss: 'attacker', aud: 'daevox-api', sub: 'admin' }),
  ).toString('base64url');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

  assert.equal(authority.verify(`${header}.${changedPayload}.${signature}`), null);
  assert.equal(authority.verify(`${header}.${payload}.${signature.slice(1)}x`), null);
  assert.equal(authority.verify(`${noneHeader}.${payload}.`), null);
  assert.equal(authority.verify('not-a-jwt'), null);
});
