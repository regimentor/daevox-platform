import { randomBytes } from 'node:crypto';
import { createAuthentication } from '../../lib/framework/Authentication.js';
import {
  bearerToken,
  oneTimeWebSocketTicket,
} from '../../lib/framework/authenticationStrategies.js';
import { AuthenticationStore } from '../authentication/AuthenticationStore.js';
import { JwtAuthority } from './JwtAuthority.js';

const TICKET_TTL = 30 * 1000;
const tickets = new Map();

export const users = new AuthenticationStore();
export const jwtAuthority = new JwtAuthority();

await users.register('demo@example.com', 'correct-horse-battery');

export function issueTicket(authSession) {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(ticket);
  }
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { authSession, expiresAt: now + TICKET_TTL });
  return ticket;
}

function consumeTicket(ticket) {
  const record = tickets.get(ticket);
  tickets.delete(ticket);
  if (!record || record.expiresAt <= Date.now() || !jwtAuthority.isActive(record.authSession)) {
    return null;
  }
  return record.authSession;
}

export const authentication = createAuthentication({
  strategies: {
    jwtBearer: bearerToken({ verify: (token) => jwtAuthority.verify(token) }),
    webSocketTicket: oneTimeWebSocketTicket({ consume: consumeTicket }),
  },
  scenarios: {
    jwtRequired: { use: ['jwtBearer'], required: true },
    webSocket: { use: ['webSocketTicket', 'jwtBearer'], required: true },
  },
});
