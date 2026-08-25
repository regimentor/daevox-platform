# Установка и первое приложение

## Требования

- Node.js 26 или новее;
- npm 12 или новее;
- ESM: в приложении должен использоваться `"type": "module"` либо расширение `.mjs`.

Установите пакет выбранным для проекта способом. Для локальной разработки этого репозитория:

```sh
npm install
```

Пока единая библиотечная точка входа отсутствует, используйте прямые импорты:

```js
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
```

Внутри самого репозитория замените имя пакета относительным путём, например
`../../lib/framework/Application.js`.

## Минимальное приложение

Создайте `main.js`:

```js
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';

class HealthHttpController extends HttpControllerBase {
  static prefix = '/health';
  static routes = [{ method: 'GET', path: '/', handler: 'check', authentication: false }];

  check() {
    return { status: 200, body: { status: 'ok' } };
  }
}

const application = new Application({
  websocket: { authentication: false },
});

application.registerHttpController(HealthHttpController);
const address = await application.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
```

Поле `websocket` обязательно даже для приложения без WebSocket-контроллеров. Значение
`authentication: false` явно отключает Authentication на WebSocket endpoint.

Запустите и проверьте приложение:

```sh
node main.js
curl -i http://127.0.0.1:3000/health/
```

## Дальше

- добавьте параметры пути, JSON-тело и собственные ответы по руководству [HTTP](http.md);
- подключите проверку credentials через [Authentication](authentication.md);
- опубликуйте события протокола по руководству [WebSocket](websocket.md);
- вынесите CPU-intensive работу в [фоновые задачи](jobs.md).
