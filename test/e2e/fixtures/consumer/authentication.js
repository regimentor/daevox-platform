import { once } from 'node:events';
import http from 'node:http';

import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { createAuthentication } from 'daevox-node-framework/lib/framework/Authentication.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from 'daevox-node-framework/lib/framework/authenticationStrategies.js';

const browserSession = {
  authSessionId: 'browser-session',
  principal: { id: 'browser-user' },
};
const sharedSession = {
  authSessionId: 'shared-session',
  principal: { id: 'api-user' },
};
const isolatedSession = {
  authSessionId: 'isolated-session',
  principal: { id: 'other-user' },
};
const tickets = new Map();
let nextTicket = 1;

const authentication = createAuthentication({
  strategies: {
    browserCookie: cookieSession({
      cookie: { name: 'session' },
      resolve: (value) => (value === 'browser-cookie' ? browserSession : null),
    }),
    apiBearer: bearerToken({
      verify(token) {
        if (token === 'shared-token') return sharedSession;
        if (token === 'isolated-token') return isolatedSession;
        if (token === 'expiring-token') {
          return {
            authSessionId: 'expiring-session',
            principal: { id: 'expiring-user' },
            expiresAt: Date.now() + 750,
          };
        }
        return null;
      },
    }),
    webSocketTicket: oneTimeWebSocketTicket({
      consume(ticket) {
        const session = tickets.get(ticket) ?? null;
        tickets.delete(ticket);
        return session;
      },
    }),
  },
  scenarios: {
    browserOptional: { use: ['browserCookie'], required: false },
    api: { use: ['apiBearer'], required: true },
    webSocket: { use: ['webSocketTicket'], required: true },
  },
});

class AuthenticationHttpController extends HttpControllerBase {
  static prefix = '/auth';
  static routes = [
    { method: 'GET', path: '/optional', handler: 'optional', authentication: 'browserOptional' },
    { method: 'POST', path: '/tickets', handler: 'issueTicket', authentication: 'api' },
    { method: 'POST', path: '/push', handler: 'push', authentication: 'api' },
  ];

  optional(ctx) {
    return {
      status: 200,
      body: Object.hasOwn(ctx, 'authSession')
        ? { authSessionId: ctx.authSession.authSessionId, hasWebSocket: true }
        : { hasAuthSession: false, hasWebSocket: false },
    };
  }

  issueTicket(ctx) {
    const ticket = `ticket-${nextTicket}`;
    nextTicket += 1;
    tickets.set(ticket, ctx.authSession);
    return { status: 201, body: { ticket } };
  }

  push(ctx) {
    const result = ctx.webSocket.send({
      controller: 'events',
      event: 'changed',
      body: { revision: ctx.body.revision },
    });
    return { status: 200, body: result };
  }
}

class EventsWebSocketController extends WebSocketControllerBase {
  static name = 'events';
  static events = [{ name: 'echo', handler: 'echo' }];

  echo(ctx) {
    return { marker: ctx.body.marker };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  return {
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
    body: await response.json(),
  };
}

async function issueTicket(httpUrl, token) {
  const response = await fetchJson(`${httpUrl}/auth/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return response.body.ticket;
}

async function openWebSocket(webSocketUrl, ticket) {
  const socket = new WebSocket(`${webSocketUrl}?ticket=${encodeURIComponent(ticket)}`, 'daevox.v1');
  await once(socket, 'open', { signal: AbortSignal.timeout(2_000) });
  return socket;
}

async function receiveMessage(socket) {
  const [event] = await once(socket, 'message', { signal: AbortSignal.timeout(2_000) });
  return JSON.parse(String(event.data));
}

async function closeWebSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closePromise = once(socket, 'close', { signal: AbortSignal.timeout(2_000) });
  socket.close(1000);
  await closePromise;
}

function rejectOrigin(address) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: address.address,
        port: address.port,
        path: '/websocket',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'sec-websocket-protocol': 'daevox.v1',
          origin: 'https://evil.example.com',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        });
      },
    );
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Disallowed Origin unexpectedly upgraded'));
    });
    request.on('error', reject);
    request.end();
  });
}

const application = new Application({
  authentication,
  websocket: {
    authentication: 'webSocket',
    allowedOrigins: ['https://app.example.com'],
  },
});
application.registerHttpController(AuthenticationHttpController);
application.registerWebSocketController(EventsWebSocketController);

const sockets = [];
let closed = false;

try {
  const address = await application.listen({ port: 0 });
  const httpUrl = `http://${address.address}:${address.port}`;
  const webSocketUrl = `ws://${address.address}:${address.port}/websocket`;

  const anonymousCookie = await fetchJson(`${httpUrl}/auth/optional`);
  const authenticatedCookie = await fetchJson(`${httpUrl}/auth/optional`, {
    headers: { cookie: 'session=browser-cookie' },
  });
  const rejection = await fetchJson(`${httpUrl}/auth/push`, {
    method: 'POST',
    headers: { authorization: 'Bearer malformed,token', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 7 }),
  });
  const origin = await rejectOrigin(address);

  const firstTicket = await issueTicket(httpUrl, 'shared-token');
  const secondTicket = await issueTicket(httpUrl, 'shared-token');
  const isolatedTicket = await issueTicket(httpUrl, 'isolated-token');
  const expiringTicket = await issueTicket(httpUrl, 'expiring-token');

  const first = await openWebSocket(webSocketUrl, firstTicket);
  const second = await openWebSocket(webSocketUrl, secondTicket);
  const isolated = await openWebSocket(webSocketUrl, isolatedTicket);
  const expiring = await openWebSocket(webSocketUrl, expiringTicket);
  sockets.push(first, second, isolated, expiring);

  const firstMessage = receiveMessage(first);
  const secondMessage = receiveMessage(second);
  const isolatedMessage = receiveMessage(isolated);
  const pushResponse = await fetchJson(`${httpUrl}/auth/push`, {
    method: 'POST',
    headers: { authorization: 'Bearer shared-token', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 7 }),
  });
  isolated.send(
    JSON.stringify({ controller: 'events', event: 'echo', body: { marker: 'isolated' } }),
  );

  const push = {
    result: pushResponse.body,
    first: await firstMessage,
    second: await secondMessage,
    isolated: await isolatedMessage,
  };
  const expiringClose = once(expiring, 'close', { signal: AbortSignal.timeout(3_000) });
  const [expiryEvent] = await expiringClose;
  const expiry = { code: expiryEvent.code, reason: expiryEvent.reason };

  await Promise.all([closeWebSocket(first), closeWebSocket(second)]);
  const matchedZeroResponse = await fetchJson(`${httpUrl}/auth/push`, {
    method: 'POST',
    headers: { authorization: 'Bearer shared-token', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 8 }),
  });
  await closeWebSocket(isolated);
  await application.close();
  closed = true;

  process.stdout.write(
    JSON.stringify({
      cookie: {
        anonymous: anonymousCookie.body,
        authenticated: authenticatedCookie.body,
      },
      rejection: {
        status: rejection.status,
        challenge: rejection.challenge,
        body: rejection.body,
      },
      origin,
      push,
      expiry,
      matchedZero: matchedZeroResponse.body,
      closed,
    }),
  );
} finally {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }
  await application.close();
}
