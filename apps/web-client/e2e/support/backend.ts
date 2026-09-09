// Test-only server. This entrypoint is never imported by the production bootstrap.
import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import { AppState } from '../../../backend/src/app-state.ts';
import { createApplication } from '../../../backend/src/application.ts';
import { TelegramConnection } from '../../../backend/src/telegram/connection.ts';
import {
  ControlledTelegram,
  parameters,
} from '../../../backend/test/support/controlled-telegram.ts';
const clients: ControlledTelegram[] = [];
const telegram = new TelegramConnection({
  parameters,
  createClient: () => {
    const mock = new ControlledTelegram();
    mock.automatic = true;
    clients.push(mock);
    return mock.client();
  },
});
class State extends AppState {
  constructor() {
    super(telegram, 'http://127.0.0.1:5174');
  }
}
class Control extends HttpControllerBase {
  static prefix = '/__test';
  static routes = [
    { method: 'POST', path: '/event', handler: 'event' },
    { method: 'GET', path: '/stats', handler: 'stats' },
  ] as const;
  async event(_state: AppState, ctx: HttpRequestContext) {
    const body = await ctx.requestBody.json();
    const event = body && typeof body === 'object' && 'event' in body ? body.event : null;
    const mock = clients.at(-1)!;
    if (event === 'password') mock.auth({ '@type': 'authorizationStateWaitPassword' });
    if (event === 'ready') mock.auth({ '@type': 'authorizationStateReady' });
    if (event === 'rotate')
      mock.auth({
        '@type': 'authorizationStateWaitOtherDeviceConfirmation',
        link: 'tg://login?token=cm90YXRlZA',
      });
    if (event === 'offline') mock.network('connectionStateWaitingForNetwork');
    if (event === 'online') mock.network('connectionStateReady');
    if (event === 'fatal') mock.handlers!.onFatal(new Error('simulated failure'));
    return { status: 200, body: { ok: true } };
  }
  stats() {
    return {
      status: 200,
      body: {
        generations: clients.length,
        connects: clients.reduce(
          (total, mock) => total + mock.count('requestQrCodeAuthentication'),
          0,
        ),
        passwords: clients.reduce(
          (total, mock) => total + mock.count('checkAuthenticationPassword'),
          0,
        ),
        logouts: clients.reduce((total, mock) => total + mock.count('logOut'), 0),
      },
    };
  }
}
const app = createApplication(State);
app.registerHttpController(Control);
await app.listen({ port: 3001, host: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
  });
