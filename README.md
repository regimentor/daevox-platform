# Daevox Node Framework

Небольшой HTTP-фреймворк для Node.js 26.

## Цели

- Низкоуровневый HTTP runtime на `node:http`.
- Декларативная регистрация контроллеров.
- Маршрутизация и нормализация запросов и ответов.
- Отмена операций через `AbortController` и `AbortSignal`.
- Тайм-ауты, корректное завершение работы и backpressure.
- Воспроизводимые benchmarks HTTP runtime.

Проект должен оставаться понятным: прямой код и небольшие модули предпочтительнее универсальных слоёв абстракций.

## Публичный API

```js
import { Application } from './lib/framework/Application.js';
import { HttpControllerBase } from './lib/framework/HttpControllerBase.js';

export class UsersController extends HttpControllerBase {
  static prefix = '/users';

  static routes = [
    {
      method: 'GET',
      path: '/',
      handler: 'list',
    },
    {
      method: 'GET',
      path: '/:id',
      handler: 'getById',
    },
  ];

  async list(ctx) {
    return { status: 200, body: { users: [] } };
  }

  async getById(ctx) {
    return { status: 200, body: { id: ctx.params.id } };
  }
}

const app = new Application({
  http: {
    bodyLimit: 1024 * 1024,
    shutdownTimeout: 30_000,
  },
});
app.registerHttpController(UsersController);
const address = await app.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);
```

`Application` принимает класс, напрямую наследующий `HttpControllerBase`. Класс HTTP-контроллера объявляет собственные статические поля `prefix` и `routes`, а каждый указанный HTTP-обработчик должен быть собственным методом его прототипа.

Нормализованное определение маршрута имеет следующий вид:

```js
{
  method: "GET",
  path: "/users/:id",
  handler: "getById",
  controller: UsersController,
}
```

## Архитектура

`Application` служит общей точкой композиции для транспортов фреймворка. HTTP-слой разделяет ответственность между следующими компонентами:

1. `Application` владеет жизненным циклом приложения и приватным экземпляром `HttpRouter`.
2. `HttpRouter` регистрирует и сопоставляет HTTP-маршруты.
3. `Job Runner` выполняет асинхронные задачи в пуле Worker.

`HttpRouter` является внутренним компонентом и не входит в пользовательский публичный API. До появления библиотечной точки входа классы публичного API импортируются напрямую из `lib/framework/`.

Принятые архитектурные решения и их обоснования находятся в [`docs/adr/`](docs/adr/).

## HTTP-ответ

HTTP-обработчик возвращает объект со статусом и необязательными WHATWG-заголовками и телом:

```js
return {
  status: 200,
  headers: new Headers({ 'x-result': 'success' }),
  body: { ok: true },
};
```

Поддерживаются JSON-значения, строки, `Buffer` и `Uint8Array`.

## Example запуска задачи по HTTP

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
