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
export class UsersController {
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
    return { users: [] };
  }

  async getById(ctx) {
    return { id: ctx.params.id };
  }
}

const app = new Application();
app.registerController(UsersController);
app.run(3000);
```

Фреймворк не требует базового класса контроллера. `Application` принимает класс структурно: по статическим полям `prefix` и `routes`, а также по доступным методам экземпляра.

Нормализованное определение маршрута имеет следующий вид:

```ts
{
  method: "GET",
  path: "/users/:id",
  handler: "getById",
  controller: UsersController,
}
```

## Архитектура

Фреймворк разделяет ответственность между тремя компонентами:

1. `Application` владеет жизненным циклом HTTP-сервера.
2. `Router` регистрирует и сопоставляет маршруты.
3. `Job Runner` выполняет асинхронные задачи в пуле Worker.

Принятые архитектурные решения и их обоснования находятся в [`docs/adr/`](docs/adr/).
