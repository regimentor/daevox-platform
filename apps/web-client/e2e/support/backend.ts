// Test-only server. This entrypoint is never imported by the production bootstrap.
import { HttpControllerBase, type HttpRequestContext } from '@daevox/framework';
import { AppState } from '../../../backend/src/app-state.ts';
import { createApplication } from '../../../backend/src/application.ts';
import { TelegramConnection } from '../../../backend/src/domain/telegram/connection.ts';
import { testDatabase } from '@daevox/db/testing';
import {
  ControlledTelegram,
  parameters,
} from '../../../backend/test/support/controlled-telegram.ts';
const clients: ControlledTelegram[] = [];
let testChat: object | null = null;
let testMessage: object | null = null;
const deliveries: Record<string, unknown>[] = [];

const database = testDatabase();
const telegram = new TelegramConnection({
  parameters,
  createClient: () => {
    const mock = new ControlledTelegram();
    mock.automatic = true;
    mock.respondTo = (request) => {
      switch (request['@type']) {
        case 'loadChats':
          return { '@type': 'error', code: 404, message: 'All loaded' };
        case 'getChats':
          return {
            '@type': 'chats',
            chat_ids: testChat ? [10] : [],
            total_count: testChat ? 1 : 0,
          };
        case 'getChat':
          return testChat ?? { '@type': 'error', code: 404, message: 'No chat' };
        case 'getChatHistory':
          return { '@type': 'messages', messages: [], total_count: 0 };
        case 'getMessage':
          return testMessage ?? { '@type': 'error', code: 404, message: 'No message' };
        case 'getMessageProperties':
          return { '@type': 'messageProperties', can_be_replied: true };
        case 'canSendMessageToUser':
          return { '@type': 'canSendMessageToUserResultOk' };
        case 'getUser':
          return {
            '@type': 'user',
            first_name: 'Test',
            last_name: 'Sender',
            usernames: { active_usernames: ['sender'] },
          };
        case 'getOption':
          return { '@type': 'optionValueInteger', value: '4096' };
        case 'sendMessage':
          deliveries.push(request);
          return {
            ...testMessage,
            '@type': 'message',
            id: 5000 + deliveries.length,
            is_outgoing: true,
            sending_state: null,
          };
      }
    };
    clients.push(mock);
    return mock.client();
  },
});
class State extends AppState {
  constructor() {
    super(telegram, 'http://127.0.0.1:5174', database.url);
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
    if (event === 'chat') {
      testChat = {
        '@type': 'chat',
        id: 10,
        title: 'Тест автоответчика',
        type: { '@type': 'chatTypePrivate', user_id: 7 },
        positions: [],
        message_sender_id: null,
      };
      mock.handlers!.onMessage({
        kind: 'update',
        clientId: mock.clientId,
        payload: { '@type': 'updateNewChat', chat: testChat },
      });
    }
    if (event === 'incoming') {
      testMessage = {
        '@type': 'message',
        id: 100 + deliveries.length,
        chat_id: 10,
        date: Math.floor(Date.now() / 1000) + 2,
        is_outgoing: false,
        sender_id: { '@type': 'messageSenderUser', user_id: 7 },
        content: { '@type': 'messageSticker' },
        topic_id: null,
        edit_date: 0,
        can_be_saved: true,
        sending_state: null,
      };
      mock.handlers!.onMessage({
        kind: 'update',
        clientId: mock.clientId,
        payload: { '@type': 'updateNewMessage', message: testMessage },
      });
    }
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
        deliveries,
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
    database.cleanup();
  });
