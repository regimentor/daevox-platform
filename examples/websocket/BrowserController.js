import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { issueTicket } from './exampleAuthentication.js';

const page = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Daevox WebSocket example</title>
    <style>
      body { max-width: 42rem; margin: 3rem auto; padding: 0 1rem; font: 16px system-ui; }
      form { display: flex; gap: .5rem; }
      input { flex: 1; padding: .6rem; }
      button { padding: .6rem 1rem; }
      output { display: block; margin: 1rem 0; color: #555; }
      li { margin: .4rem 0; }
    </style>
  </head>
  <body>
    <h1>WebSocket-протокол daevox.v1</h1>
    <p>Cookie связывает HTTP-запросы и WebSocket-соединения одной <code>AuthSession</code>. Откройте страницу в нескольких вкладках: push получит каждая вкладка этой session.</p>
    <output id="status">Проверка session…</output>
    <button id="login" hidden>Создать demo session</button>
    <form id="form">
      <input id="revision" type="number" value="1" min="0" required>
      <button>Отправить server push</button>
    </form>
    <p><code>send()</code>: <output id="send-result">ещё не вызывался</output></p>
    <ul id="messages"></ul>
    <script>
      const status = document.querySelector('#status');
      const login = document.querySelector('#login');
      const form = document.querySelector('#form');
      const revision = document.querySelector('#revision');
      const sendResult = document.querySelector('#send-result');
      const messages = document.querySelector('#messages');
      let socket;

      async function connect() {
        const response = await fetch('/session');
        const session = await response.json();
        if (!session.authenticated) {
          status.value = 'Нет browser session';
          login.hidden = false;
          form.hidden = true;
          return;
        }
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(protocol + '://' + location.host + '/websocket', 'daevox.v1');
        socket.addEventListener('open', () => {
          status.value = 'Подключено: ' + session.authSessionId;
          form.hidden = false;
        });
        socket.addEventListener('close', (event) => {
          status.value = 'Соединение закрыто: ' + event.code + ' ' + event.reason;
        });
        socket.addEventListener('message', (event) => {
          const data = JSON.parse(event.data);
          const item = document.createElement('li');
          item.textContent = JSON.stringify(data);
          messages.prepend(item);
        });
      }

      login.addEventListener('click', async () => {
        await fetch('/login', { method: 'POST' });
        location.reload();
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const response = await fetch('/push/browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision: Number(revision.value) }),
        });
        sendResult.value = JSON.stringify(await response.json());
      });
      connect();
    </script>
  </body>
</html>`;

export class BrowserController extends HttpControllerBase {
  static prefix = '/';
  static routes = [
    { method: 'GET', path: '/', handler: 'index', authentication: false },
    { method: 'POST', path: '/login', handler: 'login', authentication: false },
    {
      method: 'GET',
      path: '/session',
      handler: 'session',
      authentication: 'browserOptional',
    },
    {
      method: 'POST',
      path: '/tickets',
      handler: 'ticket',
      authentication: 'api',
    },
    {
      method: 'POST',
      path: '/push/browser',
      handler: 'push',
      authentication: 'browserRequired',
    },
    { method: 'POST', path: '/push/api', handler: 'push', authentication: 'api' },
  ];

  index() {
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: page,
    };
  }

  login() {
    return {
      status: 204,
      headers: new Headers({
        'set-cookie': 'session=browser-demo-cookie; Path=/; HttpOnly; SameSite=Strict',
      }),
    };
  }

  session(ctx) {
    if (!Object.hasOwn(ctx, 'authSession')) {
      return { status: 200, body: { authenticated: false } };
    }
    return {
      status: 200,
      body: { authenticated: true, authSessionId: ctx.authSession.authSessionId },
    };
  }

  ticket(ctx) {
    return { status: 201, body: { ticket: issueTicket(ctx.authSession) } };
  }

  push(ctx) {
    return {
      status: 200,
      body: ctx.webSocket.send({
        controller: 'events',
        event: 'changed',
        body: { revision: ctx.body.revision },
      }),
    };
  }
}
