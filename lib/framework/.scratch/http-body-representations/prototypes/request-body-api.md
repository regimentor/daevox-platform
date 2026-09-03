# PROTOTYPE: Fetch-подобный API тела HTTP-запроса

Этот throwaway-прототип сравнивает только форму public interface. Он не задаёт окончательные
правила media type, ошибок, лимитов и обратной совместимости — для них существуют отдельные
decision tickets.

## Verdict

Выбран отдельный `HttpRequestBodyReader`, доступный как всегда присутствующее read-only свойство
`ctx.requestBody`. Первая версия предоставляет только `json()`, `text()`, `bytes()` и `formData()`;
все методы асинхронны, а состояние потребления видно через `used`. `arrayBuffer()`, `blob()` и
`stream()` не входят в первую версию.

```ts
interface HttpRequestBodyReader<JsonBody = unknown> {
  readonly used: boolean;
  json(): Promise<JsonBody>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;
}

interface HttpRequestContext<JsonBody = unknown, State extends object = Record<string, unknown>> {
  readonly requestBody: HttpRequestBodyReader<JsonBody>;
}
```

Generic JSON-типа задаётся один раз через `HttpRequestContext<JsonBody>` и передаётся reader, поэтому
обработчик получает `Promise<JsonBody>` без generic на каждом вызове `json()`. Судьба существующего
`ctx.body`, совместимость текущих generic-параметров, результаты для пустого тела, правила
однократного чтения и ошибки намеренно оставлены соответствующим decision tickets.

## Сценарии проверки

Форма API должна одинаково ясно читаться в четырёх случаях:

```ts
const command = await ctx.json<CreateUserCommand>();
const source = await ctx.text();
const archive = await ctx.bytes();
const form = await ctx.formData();
```

Нужно также оставить совместимую точку для будущего, пока не реализуемого streaming:

```ts
const stream = ctx.stream();
```

## Вариант A — методы непосредственно на HttpRequestContext

```ts
interface HttpRequestContext<State extends object = Record<string, unknown>> {
  // Существующие method, path, params, query, headers, signal, state, route.
  readonly bodyUsed: boolean;
  json<Value = unknown>(): Promise<Value>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;

  // Возможное совместимое расширение отдельного streaming-effort:
  // stream(): ReadableStream<Uint8Array>;
}
```

Плюсы: ближе всего к Fetch `Request`; короткий usage; новое API может временно сосуществовать со
старым `ctx.body`. Минусы: body-операции и `bodyUsed` расширяют верхний уровень уже насыщенного
контекста; будущий `stream()` менее явно относится к телу.

## Вариант B — отдельный HttpRequestBodyReader

```ts
interface HttpRequestBodyReader {
  readonly used: boolean;
  json<Value = unknown>(): Promise<Value>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;

  // Возможное совместимое расширение:
  // stream(): ReadableStream<Uint8Array>;
}

interface HttpRequestContext<State extends object = Record<string, unknown>> {
  readonly requestBody: HttpRequestBodyReader;
}
```

Usage:

```ts
const command = await ctx.requestBody.json<CreateUserCommand>();
const form = await ctx.requestBody.formData();
```

Плюсы: body-семантика, состояние потребления и будущий streaming образуют отдельный глубокий
module; не конфликтует со старым `ctx.body`. Минусы: длиннее Fetch API; вводит новое публичное имя
`requestBody`, хотя сам `HttpRequestContext` уже однозначно относится к запросу.

## Вариант C — заменить ctx.body объектом операций

```ts
interface HttpRequestBody {
  readonly used: boolean;
  json<Value = unknown>(): Promise<Value>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;

  // Возможное совместимое расширение:
  // stream(): ReadableStream<Uint8Array>;
}

interface HttpRequestContext<State extends object = Record<string, unknown>> {
  readonly body: HttpRequestBody;
}
```

Usage:

```ts
const command = await ctx.body.json<CreateUserCommand>();
const form = await ctx.body.formData();
```

Плюсы: наиболее связная модель тела и естественный seam для streaming. Минусы: напрямую меняет
смысл существующего `ctx.body` с разобранного JSON-значения на reader и потому требует ломающей
миграции либо отдельного compatibility-механизма.

## Предварительная рекомендация до verdict

Вариант B даёт наиболее глубокую границу: вся изменяемая семантика чтения тела скрыта за одним
`HttpRequestBodyReader`, а `HttpRequestContext` остаётся нормализованным snapshot метаданных
запроса. Он не использует уже занятое имя `body` и позволяет позднее добавить `stream()` локально,
не расширяя весь context.

Если приоритетом является буквальная близость к Fetch и минимальный usage, вариант A дешевле для
пользователя. Вариант C имеет лучшую идеальную форму, но худшую совместимость.
