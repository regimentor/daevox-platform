Status: resolved
Type: grilling
Blocked by: 02, 03, 04, 06

# Зафиксировать типы и seam будущего streaming

## Question

Какие TypeScript-типы, generics и public exports нужны Fetch-подобным операциям, какие гарантии
можно проверить при регистрации HTTP-контроллера, и какая совместимая точка расширения позволит
позднее добавить streaming без возвращения `IncomingMessage` или поломки принятого interface?
Сохранить принятое требование: JSON-тип задаётся через generic `HttpRequestContext<JsonBody>` и
распространяется в `requestBody.json(): Promise<JsonBody>`. Сохранить порядок параметров
`HttpRequestContext<JsonBody, State>` при удалении существующего `ctx.body`; определить defaults,
variance и registration-time проверки.
Определить public TypeScript-тип для `bodyLimit: number | ByteSize`, сохранив строгую runtime-
грамматику целых значений с единицами `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, `GiB`.
Определить public сигнатуры `HttpRequestBodyError`, его code/status и связь с `ErrorOptions.cause`,
не допуская сериализации внутренних error details в автоматический HTTP-ответ.

## Answer

Public reader и контекст имеют следующий контракт:

```ts
export interface HttpRequestBodyReader<JsonBody = unknown> {
  readonly used: boolean;
  json(): Promise<JsonBody>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;
}

export interface HttpRequestContext<
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> {
  // Существующие metadata, signal и state.
  readonly requestBody: HttpRequestBodyReader<JsonBody>;
}
```

Default `unknown` заменяет нынешний `any`. Method-level `json<Override>()` не поддерживается:
JSON-тип задаётся один раз через `HttpRequestContext<JsonBody, State>` и является утверждением
прикладного TypeScript-кода без runtime-валидации схемы.

`HttpHandler` и `HttpMiddleware` получают необязательные generic-параметры `JsonBody` и `State`
после `AppState`, чтобы standalone-функции можно было типизировать без повторения полной сигнатуры
контекста. Application- и controller-wide middleware по умолчанию видят `JsonBody = unknown`, так
как обслуживают разные HTTP-маршруты. Внутренняя registration-time проверка стирает body/state-
параметры: она продолжает доказывать `AppState`, форму контекста, имя handler и `HttpResponse`, но не
делает вид, что проверяет прикладную JSON-схему.

Публичный строковый размер имеет template-literal тип `ByteSize` с регистронезависимыми вариантами
единиц `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, `GiB`. Template type является compile-time
приближением; строгая runtime-проверка по принятой грамматике остаётся авторитетной для
неотрицательности, safe integer и отсутствия дробей/экспонент.

```ts
export interface HttpOptions {
  bodyLimit?: number | ByteSize;
}

export interface HttpRouteDeclaration<AppState> {
  // Существующие method, path, handler и middleware.
  bodyLimit?: number | ByteSize;
}
```

`HttpRouteContext` не получает `bodyLimit`: effective нормализованное значение является внутренней
transport policy, а не частью публичной идентичности найденного HTTP-маршрута.

Ошибки reader публикуются единым классом:

```ts
export type HttpRequestBodyErrorCode = 'MALFORMED_BODY' | 'UNSUPPORTED_MEDIA_TYPE';

export class HttpRequestBodyError extends Error {
  readonly code: HttpRequestBodyErrorCode;
  readonly status: 400 | 415;

  constructor(code: HttpRequestBodyErrorCode, options?: ErrorOptions);
}
```

`status` однозначно выводится из `code`; `ErrorOptions.cause` доступен серверному коду, но не
сериализуется автоматическим ответом.

Корневой `src/index.ts` экспортирует `HttpRequestBodyReader`, `HttpRequestBodyError`,
`HttpRequestBodyErrorCode` и `ByteSize`. Платформенные `Buffer`, `FormData`, `File`, `DOMException`
и `ReadableStream` framework повторно не экспортирует.

Будущий streaming-effort сможет совместимо добавить
`stream(): ReadableStream<Uint8Array>` на `HttpRequestBodyReader`. Метод будет конкурировать с
остальными операциями через тот же `used` и не раскроет `IncomingMessage` или Node.js `Readable`.
Сейчас `stream()` отсутствует в public interface; внутренняя реализация reader не должна закреплять
предварительное буферизование как публичную гарантию.
