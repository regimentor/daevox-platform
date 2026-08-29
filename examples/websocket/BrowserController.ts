import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.ts';

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
    <p>Сообщение адресуется WebSocket-контроллеру <code>events</code> и событию <code>echo</code>.</p>
    <output id="status">Подключение…</output>
    <form id="form">
      <input id="message" autocomplete="off" placeholder="Сообщение" required>
      <button>Отправить</button>
    </form>
    <button id="broadcast" type="button">Отправить server push из HTTP</button>
    <ul id="messages"></ul>
    <script>
      const status = document.querySelector('#status');
      const form = document.querySelector('#form');
      const input = document.querySelector('#message');
      const messages = document.querySelector('#messages');
      const broadcast = document.querySelector('#broadcast');
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(protocol + '://' + location.host + '/websocket?token=demo', 'daevox.v1');

      socket.addEventListener('open', () => {
        status.value = 'Подключено по протоколу ' + socket.protocol;
      });
      socket.addEventListener('close', () => {
        status.value = 'Соединение закрыто';
      });
      socket.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        const item = document.createElement('li');
        item.textContent = data.body.message + ' #' + data.body.messageCount + ' (' + data.controller + '/' + data.event + ')';
        messages.prepend(item);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        socket.send(JSON.stringify({
          controller: 'events',
          event: 'echo',
          body: { message: input.value },
        }));
        input.value = '';
      });
      broadcast.addEventListener('click', async () => {
        const response = await fetch('/broadcast');
        status.value = 'HTTP server push: ' + JSON.stringify(await response.json());
      });
    </script>
  </body>
</html>`;

export class BrowserController extends HttpControllerBase {
  static prefix = '/';
  static routes = [{ method: 'GET', path: '/', handler: 'index' }];

  index() {
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: page,
    };
  }
}
