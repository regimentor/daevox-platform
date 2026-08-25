import { createAuthentication } from '../../lib/framework/Authentication.js';
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from '../../lib/framework/authenticationStrategies.js';
import { authenticationStore } from './AuthenticationStore.js';

export const authentication = createAuthentication({
  strategies: {
    browserCookie: cookieSession({
      cookie: { name: 'session' },
      resolve: (credential) => authenticationStore.resolveBrowserSession(credential),
    }),
    apiBearer: bearerToken({
      verify: (credential) => authenticationStore.resolveApiToken(credential),
    }),
    webSocketTicket: oneTimeWebSocketTicket({
      consume: (credential) => authenticationStore.consumeTicket(credential),
    }),
  },
  scenarios: {
    browserOptional: { use: ['browserCookie'], required: false },
    browserRequired: { use: ['browserCookie'], required: true },
    apiRequired: { use: ['apiBearer'], required: true },
    webSocket: { use: ['webSocketTicket', 'browserCookie'], required: true },
  },
});
