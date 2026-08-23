# Daevox Node Framework

Небольшой HTTP-фреймворк для Node.js 26 без runtime-зависимостей. Он объединяет декларативные HTTP-контроллеры, нормализацию запросов и ответов и выполнение фоновых задач в пуле `worker_threads`.

## Возможности

- HTTP runtime на `node:http`.
- Декларативная регистрация HTTP-контроллеров и параметризованных HTTP-маршрутов.
- JSON-запросы и нормализованные JSON, текстовые и бинарные HTTP-ответы.
- Отмена операций через `AbortSignal`.
- Ограничение размера тела запроса и корректное завершение работы.
- Фоновые задачи с очередью, тайм-аутами и изоляцией в Worker.
- Нулевые runtime-зависимости.

Проект должен оставаться понятным: прямой код и небольшие модули предпочтительнее универсальных слоёв абстракций.

## Требования

- Node.js 26 или новее.
- npm 12 или новее.

## Быстрый старт

```js
import { Application } from './lib/framework/Application.js';
import { HttpControllerBase } from './lib/framework/HttpControllerBase.js';

class UsersController extends HttpControllerBase {
  static prefix = '/users';

  static routes = [
    { method: 'GET', path: '/', handler: 'list' },
    { method: 'GET', path: '/:id', handler: 'getById' },
  ];

  async list() {
    return { status: 200, body: { users: [] } };
  }

  async getById(ctx) {
    return { status: 200, body: { id: ctx.params.id } };
  }
}

const application = new Application({
  http: {
    bodyLimit: 1024 * 1024,
    shutdownTimeout: 30_000,
  },
});

application.registerHttpController(UsersController);
const address = await application.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);
```

До появления библиотечной точки входа классы публичного API импортируются напрямую из `lib/framework/`.

## HTTP-контроллеры и маршруты

`Application.registerHttpController()` принимает класс, напрямую наследующий `HttpControllerBase`. Класс объявляет собственные статические поля `prefix` и `routes`, а каждый указанный HTTP-обработчик должен быть собственным методом его прототипа.

Объявление HTTP-маршрута содержит ровно три поля:

```js
{ method: 'GET', path: '/:id', handler: 'getById' }
```

После регистрации оно нормализуется с учётом префикса HTTP-контроллера:

```js
{
  method: 'GET',
  path: '/users/:id',
  handler: 'getById',
  controller: UsersController,
}
```

HTTP-контроллеры можно регистрировать только до вызова `listen()`. Для каждого найденного HTTP-маршрута приложение создаёт новый экземпляр HTTP-контроллера.

### Контекст HTTP-запроса

HTTP-обработчик получает объект `ctx`:

```js
{
  method,  // HTTP-метод
  path,    // путь запроса
  params,  // параметры HTTP-маршрута
  query,   // URLSearchParams
  headers, // WHATWG Headers
  body,    // разобранное JSON-тело или undefined
  signal,  // AbortSignal запроса
}
```

Непустое тело запроса должно иметь media type `application/json` или `*+json` и кодировку UTF-8. Максимальный размер задаётся опцией `http.bodyLimit`.

### HTTP-ответы и ошибки

HTTP-обработчик возвращает объект со статусом и необязательными WHATWG-заголовками и телом:

```js
return {
  status: 200,
  headers: new Headers({ 'x-result': 'success' }),
  body: { ok: true },
};
```

Поддерживаются JSON-совместимые значения, строки, `Buffer` и `Uint8Array`. Заголовок `content-type` выбирается автоматически, если HTTP-обработчик не указал его явно. Заголовки `content-length`, `transfer-encoding` и `connection` устанавливаются транспортом и не могут быть заданы HTTP-обработчиком.

Для ожидаемой ошибки HTTP-обработчик может выбросить `HttpError`:

```js
import { HttpError } from './lib/framework/errors.js';

throw new HttpError(422, {
  body: { error: 'email is required' },
});
```

Неожиданные ошибки преобразуются в ответ `500`. Опция `http.onError(error, ctx)` позволяет записать их в журнал, не раскрывая детали клиенту.

## Фоновые задачи

Фоновая задача должна напрямую наследовать `Job`, экспортироваться по умолчанию из собственного ESM-модуля, объявлять `static metaUrl = import.meta.url` и иметь собственный метод `run()`:

```js
import { Job } from './lib/framework/Job.js';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }) {
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  }
}
```

Экземпляр HTTP-контроллера получает принадлежащий приложению исполнитель задач как `this.jobRunner`:

```js
const result = await this.jobRunner.run(SumJob, ctx.body, {
  signal: ctx.signal,
  timeout: 5_000,
});

return { status: 200, body: result };
```

Payload и результат задачи должны поддерживать алгоритм structured clone. Transferable-объекты пока не поддерживаются.

Пул настраивается при создании приложения:

```js
const application = new Application({
  jobs: {
    poolSize: 4,
    queueSize: 1000,
    defaultTimeout: 10_000,
    terminationGracePeriod: 1_000,
    shutdownTimeout: 30_000,
  },
});
```

## Жизненный цикл

`Application.listen()` можно вызвать один раз. `Application.close()` прекращает приём новых HTTP-запросов, ожидает активные запросы в пределах `http.shutdownTimeout`, а затем закрывает пул Worker. После закрытия приложение нельзя запустить повторно.

```js
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
```

## Пример HTTP-запуска задачи

Запустите приложение:

```sh
npm run example:jobs-http
```

В другом терминале отправьте запрос:

```sh
curl -i -X POST http://127.0.0.1:3000/jobs/sum \
  -H 'content-type: application/json' \
  -d '{"values":[1,2,3]}'
```

Успешный ответ содержит `{"sum":6}`.

## Разработка

```sh
npm install
npm test
npm run check
```

`npm run check` последовательно выполняет проверку синтаксиса, линтинг, проверку форматирования и тесты.

## Архитектура

`Application` служит общей точкой композиции для транспортов фреймворка и владеет жизненным циклом HTTP runtime и исполнителя задач.

1. `Application` регистрирует HTTP-контроллеры, запускает HTTP transport и координирует завершение работы.
2. Внутренний `HttpRouter` регистрирует и сопоставляет HTTP-маршруты.
3. Внутренний `Job Runner` принимает классы задач и передаёт их в Worker Pool.
4. Внутренний Worker Pool управляет потоками Worker, очередью и завершением задач.

`HttpRouter`, `Job Runner` и Worker Pool не входят в пользовательский публичный API. Принятые архитектурные решения и их обоснования находятся в [`docs/adr/`](docs/adr/).
