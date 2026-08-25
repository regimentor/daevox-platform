import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { HttpError } from '../../lib/framework/errors.js';
import { issueTicket, jwtAuthority, users } from './jwtAuthentication.js';

const page = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Daevox JWT authentication example</title>
    <style>
      body { max-width: 48rem; margin: 2rem auto; padding: 0 1rem; font: 16px system-ui; }
      section { margin: 1.5rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: .5rem; }
      form { display: flex; flex-wrap: wrap; gap: .5rem; }
      input, button { padding: .55rem; }
      output { display: block; margin-top: .75rem; white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <h1>JWT authentication</h1>
    <p>Демо-пользователь: <code>demo@example.com</code>, пароль <code>correct-horse-battery</code>.</p>
    <section>
      <form id="login">
        <input id="email" type="email" value="demo@example.com" required>
        <input id="password" type="password" value="correct-horse-battery" required>
        <button>Получить JWT</button>
      </form>
      <button id="profile" disabled>GET /profile</button>
      <button id="connect" disabled>JWT → ticket → WebSocket</button>
      <button id="push" disabled>Server push</button>
      <button id="revoke" disabled>Отозвать JWT</button>
      <output id="status">JWT ещё не выпущен</output>
    </section>
    <ul id="events"></ul>
    <script>
      const status = document.querySelector('#status');
      const events = document.querySelector('#events');
      const buttons = ['profile', 'connect', 'push', 'revoke'].map((id) => document.querySelector('#' + id));
      let token;

      async function request(path, options = {}) {
        const response = await fetch(path, options);
        const body = response.status === 204 ? null : await response.json();
        if (!response.ok) throw new Error(JSON.stringify(body));
        return body;
      }

      function authorized(method = 'GET') {
        return { method, headers: { authorization: 'Bearer ' + token } };
      }

      document.querySelector('#login').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const result = await request('/tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: document.querySelector('#email').value, password: document.querySelector('#password').value }),
          });
          token = result.access_token;
          status.value = JSON.stringify(result, null, 2);
          for (const button of buttons) button.disabled = false;
        } catch (error) { status.value = error.message; }
      });

      document.querySelector('#profile').addEventListener('click', async () => {
        try { status.value = JSON.stringify(await request('/profile', authorized()), null, 2); }
        catch (error) { status.value = error.message; }
      });

      document.querySelector('#connect').addEventListener('click', async () => {
        try {
          const { ticket } = await request('/tickets', authorized('POST'));
          const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
          const socket = new WebSocket(protocol + '://' + location.host + '/websocket?ticket=' + encodeURIComponent(ticket), 'daevox.v1');
          socket.addEventListener('open', () => socket.send(JSON.stringify({ controller: 'events', event: 'whoami', body: {} })));
          socket.addEventListener('message', (event) => {
            const item = document.createElement('li');
            item.textContent = event.data;
            events.prepend(item);
          });
          socket.addEventListener('close', (event) => { status.value = 'WebSocket closed: ' + event.code + ' ' + event.reason; });
        } catch (error) { status.value = error.message; }
      });

      document.querySelector('#push').addEventListener('click', async () => {
        try { status.value = JSON.stringify(await request('/push', authorized('POST'))); }
        catch (error) { status.value = error.message; }
      });

      document.querySelector('#revoke').addEventListener('click', async () => {
        try {
          await request('/tokens', authorized('DELETE'));
          status.value = 'JWT отозван; следующий HTTP-запрос получит 401';
        } catch (error) { status.value = error.message; }
      });
    </script>
  </body>
</html>`;

function credentials(body) {
  if (typeof body?.email !== 'string' || typeof body?.password !== 'string') {
    throw new HttpError(422, { body: { error: 'email and password are required' } });
  }
  return body;
}

export class JwtController extends HttpControllerBase {
  static prefix = '/';
  static routes = [
    { method: 'GET', path: '/', handler: 'index', authentication: false },
    { method: 'POST', path: '/tokens', handler: 'issueToken', authentication: false },
    { method: 'DELETE', path: '/tokens', handler: 'revokeToken', authentication: 'jwtRequired' },
    { method: 'GET', path: '/profile', handler: 'profile', authentication: 'jwtRequired' },
    { method: 'POST', path: '/tickets', handler: 'ticket', authentication: 'jwtRequired' },
    { method: 'POST', path: '/push', handler: 'push', authentication: 'jwtRequired' },
  ];

  index() {
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: page,
    };
  }

  async issueToken(ctx) {
    const { email, password } = credentials(ctx.body);
    const principal = await users.verifyPassword(email, password);
    if (!principal) throw new HttpError(401, { body: { error: 'invalid credentials' } });
    const jwt = jwtAuthority.issue(principal);
    return {
      status: 201,
      body: {
        token_type: 'Bearer',
        access_token: jwt.token,
        expires_at: jwt.expiresAt,
      },
    };
  }

  revokeToken(ctx) {
    jwtAuthority.revoke(ctx.authSession);
    return { status: 204 };
  }

  profile(ctx) {
    return { status: 200, body: { principal: ctx.authSession.principal } };
  }

  ticket(ctx) {
    return { status: 201, body: { ticket: issueTicket(ctx.authSession), expiresIn: 30 } };
  }

  push(ctx) {
    return {
      status: 200,
      body: ctx.webSocket.send({
        controller: 'events',
        event: 'jwt',
        body: { sentAt: Date.now() },
      }),
    };
  }
}
