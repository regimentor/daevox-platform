import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { HttpError } from '../../lib/framework/errors.js';
import { authenticationStore } from './AuthenticationStore.js';

const page = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Daevox authentication example</title>
    <style>
      body { max-width: 52rem; margin: 2rem auto; padding: 0 1rem; font: 16px system-ui; }
      section { margin: 1.5rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: .5rem; }
      form { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
      input { min-width: 12rem; padding: .55rem; }
      button { padding: .55rem .8rem; }
      output { display: block; margin-top: .75rem; white-space: pre-wrap; word-break: break-word; }
      code { word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Полный authentication flow</h1>
    <p>Регистрация и вход создают HttpOnly cookie-сессию. Из неё можно выпустить Bearer-токен, обменять его на одноразовый WebSocket ticket и проверить server push для обеих AuthSession.</p>

    <section>
      <h2>1. Browser session</h2>
      <form id="credentials">
        <input id="email" type="email" value="demo@example.com" required>
        <input id="password" type="password" value="correct-horse-battery" minlength="12" required>
        <button name="action" value="register">Регистрация</button>
        <button name="action" value="login">Вход</button>
      </form>
      <button id="logout">Выход</button>
      <button id="browser-push">Push в browser session</button>
      <output id="browser-status"></output>
    </section>

    <section>
      <h2>2. Bearer → one-time WebSocket ticket</h2>
      <button id="token">Выпустить Bearer-токен</button>
      <button id="ticket" disabled>Получить ticket и подключиться</button>
      <button id="api-push" disabled>Push в API session</button>
      <button id="revoke" disabled>Отозвать Bearer-токен</button>
      <output id="api-status"></output>
    </section>

    <section>
      <h2>WebSocket events</h2>
      <ul id="events"></ul>
    </section>

    <script>
      const browserStatus = document.querySelector('#browser-status');
      const apiStatus = document.querySelector('#api-status');
      const events = document.querySelector('#events');
      const ticketButton = document.querySelector('#ticket');
      const apiPushButton = document.querySelector('#api-push');
      const revokeButton = document.querySelector('#revoke');
      let token;
      const sockets = new Set();

      async function request(path, options = {}) {
        const response = await fetch(path, options);
        const body = response.status === 204 ? null : await response.json();
        if (!response.ok) throw new Error(JSON.stringify(body));
        return body;
      }

      function connect(label, ticket) {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        const query = ticket ? '?ticket=' + encodeURIComponent(ticket) : '';
        const socket = new WebSocket(protocol + '://' + location.host + '/websocket' + query, 'daevox.v1');
        sockets.add(socket);
        socket.addEventListener('open', () => {
          browserStatus.value = label + ' WebSocket подключён';
          socket.send(JSON.stringify({ controller: 'events', event: 'whoami', body: {} }));
        });
        socket.addEventListener('message', (event) => {
          const item = document.createElement('li');
          item.textContent = label + ': ' + event.data;
          events.prepend(item);
        });
        socket.addEventListener('close', (event) => {
          sockets.delete(socket);
          const item = document.createElement('li');
          item.textContent = label + ' closed: ' + event.code + ' ' + event.reason;
          events.prepend(item);
        });
      }

      async function refreshSession() {
        try {
          const session = await request('/session');
          browserStatus.value = session.authenticated
            ? 'Authenticated: ' + JSON.stringify(session.principal)
            : 'Нет browser session';
          if (session.authenticated && sockets.size === 0) connect('browser');
        } catch (error) {
          browserStatus.value = error.message;
        }
      }

      document.querySelector('#credentials').addEventListener('submit', async (event) => {
        event.preventDefault();
        const action = event.submitter.value;
        try {
          await request('/' + action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: document.querySelector('#email').value,
              password: document.querySelector('#password').value,
            }),
          });
          location.reload();
        } catch (error) {
          browserStatus.value = error.message;
        }
      });

      document.querySelector('#logout').addEventListener('click', async () => {
        try {
          for (const socket of sockets) socket.close(1000, 'Logout');
          await request('/logout', { method: 'POST' });
          location.reload();
        } catch (error) {
          browserStatus.value = error.message;
        }
      });

      document.querySelector('#browser-push').addEventListener('click', async () => {
        try {
          browserStatus.value = JSON.stringify(await request('/push/browser', { method: 'POST' }));
        } catch (error) {
          browserStatus.value = error.message;
        }
      });

      document.querySelector('#token').addEventListener('click', async () => {
        try {
          const result = await request('/tokens', { method: 'POST' });
          token = result.token;
          apiStatus.value = 'Bearer ' + token;
          ticketButton.disabled = false;
          apiPushButton.disabled = false;
          revokeButton.disabled = false;
        } catch (error) {
          apiStatus.value = error.message;
        }
      });

      ticketButton.addEventListener('click', async () => {
        try {
          const result = await request('/tickets', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token },
          });
          connect('ticket', result.ticket);
        } catch (error) {
          apiStatus.value = error.message;
        }
      });

      apiPushButton.addEventListener('click', async () => {
        try {
          apiStatus.value = JSON.stringify(await request('/push/api', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token },
          }));
        } catch (error) {
          apiStatus.value = error.message;
        }
      });

      revokeButton.addEventListener('click', async () => {
        try {
          await request('/tokens', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ' + token },
          });
          token = undefined;
          ticketButton.disabled = true;
          apiPushButton.disabled = true;
          revokeButton.disabled = true;
          apiStatus.value = 'Bearer-токен отозван';
        } catch (error) {
          apiStatus.value = error.message;
        }
      });

      refreshSession();
    </script>
  </body>
</html>`;

function credentials(body) {
  const email = body?.email;
  const password = body?.password;
  if (
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 1024
  ) {
    throw new HttpError(422, {
      body: { error: 'email must be valid and password must contain 12–1024 characters' },
    });
  }
  return { email, password };
}

function sessionCookie(credential) {
  return `session=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`;
}

function clearSessionCookie() {
  return 'session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

export class AuthenticationController extends HttpControllerBase {
  static prefix = '/';
  static routes = [
    { method: 'GET', path: '/', handler: 'index', authentication: false },
    { method: 'POST', path: '/register', handler: 'register', authentication: false },
    { method: 'POST', path: '/login', handler: 'login', authentication: false },
    {
      method: 'GET',
      path: '/session',
      handler: 'session',
      authentication: 'browserOptional',
    },
    {
      method: 'POST',
      path: '/logout',
      handler: 'logout',
      authentication: 'browserRequired',
    },
    {
      method: 'POST',
      path: '/tokens',
      handler: 'issueToken',
      authentication: 'browserRequired',
    },
    {
      method: 'DELETE',
      path: '/tokens',
      handler: 'revokeToken',
      authentication: 'apiRequired',
    },
    {
      method: 'POST',
      path: '/tickets',
      handler: 'issueTicket',
      authentication: 'apiRequired',
    },
    {
      method: 'POST',
      path: '/push/browser',
      handler: 'push',
      authentication: 'browserRequired',
    },
    {
      method: 'POST',
      path: '/push/api',
      handler: 'push',
      authentication: 'apiRequired',
    },
  ];

  index() {
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: page,
    };
  }

  async register(ctx) {
    const { email, password } = credentials(ctx.body);
    const principal = await authenticationStore.register(email, password);
    if (!principal) throw new HttpError(409, { body: { error: 'email is already registered' } });
    return this.#browserSessionResponse(principal, 201);
  }

  async login(ctx) {
    const { email, password } = credentials(ctx.body);
    const principal = await authenticationStore.verifyPassword(email, password);
    if (!principal) throw new HttpError(401, { body: { error: 'invalid credentials' } });
    return this.#browserSessionResponse(principal, 200);
  }

  session(ctx) {
    if (!Object.hasOwn(ctx, 'authSession')) {
      return { status: 200, body: { authenticated: false } };
    }
    return {
      status: 200,
      body: { authenticated: true, principal: ctx.authSession.principal },
    };
  }

  logout(ctx) {
    authenticationStore.revokeBrowserSession(ctx.authSession.authSessionId);
    return {
      status: 204,
      headers: new Headers({ 'set-cookie': clearSessionCookie() }),
    };
  }

  issueToken(ctx) {
    const { credential, authSession } = authenticationStore.issueApiToken(
      ctx.authSession.principal,
    );
    return {
      status: 201,
      body: { token: credential, expiresAt: authSession.expiresAt },
    };
  }

  revokeToken(ctx) {
    authenticationStore.revokeApiToken(ctx.authSession.authSessionId);
    return { status: 204 };
  }

  issueTicket(ctx) {
    return {
      status: 201,
      body: { ticket: authenticationStore.issueTicket(ctx.authSession), expiresIn: 30 },
    };
  }

  push(ctx) {
    return {
      status: 200,
      body: ctx.webSocket.send({
        controller: 'events',
        event: 'authentication',
        body: { sentAt: Date.now() },
      }),
    };
  }

  #browserSessionResponse(principal, status) {
    const { credential, authSession } = authenticationStore.createBrowserSession(principal);
    return {
      status,
      headers: new Headers({ 'set-cookie': sessionCookie(credential) }),
      body: { principal, expiresAt: authSession.expiresAt },
    };
  }
}
