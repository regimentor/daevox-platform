import { createAuthentication } from '../../lib/framework/Authentication.js';
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from '../../lib/framework/authenticationStrategies.js';

const browserSession = {
  authSessionId: 'browser-demo-session',
  principal: { id: 'browser-demo' },
};
const apiSession = {
  authSessionId: 'api-demo-session',
  principal: { id: 'api-demo' },
};
const tickets = new Map();
let nextTicket = 1;

export const authentication = createAuthentication({
  strategies: {
    browserCookie: cookieSession({
      cookie: { name: 'session' },
      resolve: (value) => (value === 'browser-demo-cookie' ? browserSession : null),
    }),
    apiBearer: bearerToken({
      verify: (token) => (token === 'demo-api-token' ? apiSession : null),
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
    browserRequired: { use: ['browserCookie'], required: true },
    api: { use: ['apiBearer'], required: true },
    webSocket: { use: ['webSocketTicket', 'browserCookie'], required: true },
  },
});

export function issueTicket(authSession) {
  const ticket = `demo-ticket-${nextTicket}`;
  nextTicket += 1;
  tickets.set(ticket, authSession);
  return ticket;
}
