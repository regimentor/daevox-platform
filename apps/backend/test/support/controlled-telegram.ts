import { TdlibClient, type TdlibTransport, type TransportClientHandlers } from '@daevox/tdlib';
import { telegramParameters } from '../../src/telegram/config.ts';

// Public test values only; never points at a personal session directory.
export const parameters = telegramParameters({
  TELEGRAM_API_ID: '12345',
  TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
  TELEGRAM_DATABASE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  TELEGRAM_DATABASE_DIRECTORY: '/tmp/daevox-test-session/database',
  TELEGRAM_FILES_DIRECTORY: '/tmp/daevox-test-session/files',
})!;
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export class ControlledTelegram implements TdlibTransport {
  handlers?: TransportClientHandlers;
  clientId = '';
  authorization: object;
  requests: Array<{ requestId: string; request: Record<string, unknown> }> = [];
  destroyGate?: Promise<void>;
  destroyed = false;
  startGate?: Promise<void>;
  stateGate?: Promise<void>;
  automatic = false;
  metadataError = false;
  constructor(authorization: object = { '@type': 'authorizationStateWaitPhoneNumber' }) {
    this.authorization = authorization;
  }
  client() {
    return new TdlibClient({ transport: this });
  }
  async start(id: string, _path: string, _timeout: number, handlers: TransportClientHandlers) {
    this.clientId = id;
    this.handlers = handlers;
    await this.startGate;
    this.network('connectionStateReady');
  }
  send(_id: string, requestId: string, request: Record<string, unknown>) {
    this.requests.push({ requestId, request });
    const reply = (payload: object) => this.respond(requestId, payload);
    switch (request['@type']) {
      case 'getAuthorizationState': {
        const state = this.authorization;
        if (this.stateGate) void this.stateGate.then(() => reply(state));
        else reply(state);
        break;
      }
      case 'setTdlibParameters':
        reply({ '@type': 'ok' });
        this.auth({ '@type': 'authorizationStateWaitPhoneNumber' });
        break;
      case 'setLogStream':
      case 'close':
        reply({ '@type': 'ok' });
        break;
      case 'getMe':
        if (this.metadataError) {
          reply({ '@type': 'error', code: 500, message: 'private metadata error' });
          break;
        }
        reply({
          '@type': 'user',
          id: 42,
          first_name: 'Test',
          last_name: 'Account',
          usernames: { active_usernames: ['test_account'] },
        });
        break;
      default:
        if (this.automatic) {
          reply({ '@type': 'ok' });
          if (request['@type'] === 'requestQrCodeAuthentication')
            this.auth({
              '@type': 'authorizationStateWaitOtherDeviceConfirmation',
              link: 'tg://login?token=dGVzdA',
            });
          if (request['@type'] === 'checkAuthenticationPassword')
            this.auth({ '@type': 'authorizationStateReady' });
          if (request['@type'] === 'logOut') {
            this.auth({ '@type': 'authorizationStateLoggingOut' });
            setTimeout(() => this.auth({ '@type': 'authorizationStateClosed' }), 50);
          }
        }
    }
  }
  respond(requestId: string, payload: object) {
    this.handlers?.onMessage({ kind: 'response', clientId: this.clientId, requestId, payload });
  }
  result(type: string, payload: object = { '@type': 'ok' }) {
    const request = this.requests.findLast((entry) => entry.request['@type'] === type);
    if (!request) throw new Error(`Missing test request: ${type}`);
    this.respond(request.requestId, payload);
  }
  auth(state: object) {
    this.authorization = state;
    this.handlers?.onMessage({
      kind: 'update',
      clientId: this.clientId,
      payload: { '@type': 'updateAuthorizationState', authorization_state: state },
    });
  }
  network(type: string) {
    this.handlers?.onMessage({
      kind: 'update',
      clientId: this.clientId,
      payload: { '@type': 'updateConnectionState', state: { '@type': type } },
    });
  }
  async destroy() {
    await this.destroyGate;
    this.destroyed = true;
  }
  count(type: string) {
    return this.requests.filter((entry) => entry.request['@type'] === type).length;
  }
}
