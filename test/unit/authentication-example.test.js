import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationStore } from '../../examples/authentication/AuthenticationStore.js';

test('authentication example выполняет password и browser-session flow', async () => {
  const store = new AuthenticationStore();
  const principal = await store.register('Demo@Example.com', 'correct-horse-battery');

  assert.equal(principal.email, 'demo@example.com');
  assert.equal(await store.register('demo@example.com', 'correct-horse-battery'), null);
  assert.equal(await store.verifyPassword('demo@example.com', 'wrong-password'), null);
  assert.deepEqual(
    await store.verifyPassword('DEMO@example.com', 'correct-horse-battery'),
    principal,
  );

  const browser = store.createBrowserSession(principal);
  assert.deepEqual(store.resolveBrowserSession(browser.credential), browser.authSession);
  assert.equal(store.revokeBrowserSession(browser.authSession.authSessionId), true);
  assert.equal(store.resolveBrowserSession(browser.credential), null);
});

test('authentication example погашает ticket один раз и учитывает отзыв Bearer', () => {
  const store = new AuthenticationStore();
  const principal = { id: 'user-1', email: 'demo@example.com' };
  const api = store.issueApiToken(principal);
  const ticket = store.issueTicket(api.authSession);

  assert.deepEqual(store.resolveApiToken(api.credential), api.authSession);
  assert.deepEqual(store.consumeTicket(ticket), api.authSession);
  assert.equal(store.consumeTicket(ticket), null);

  const revokedTicket = store.issueTicket(api.authSession);
  assert.equal(store.revokeApiToken(api.authSession.authSessionId), true);
  assert.equal(store.resolveApiToken(api.credential), null);
  assert.equal(store.consumeTicket(revokedTicket), null);
});
