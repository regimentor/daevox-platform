Status: resolved
Type: prototype

# Конкретизировать Fetch-подобный API чтения тела

## Question

Как должен выглядеть минимальный публичный `HttpRequestContext` с ленивыми однократными операциями
чтения JSON, текста, bytes и формы, чтобы его usage был понятен на примерах и чтобы interface не
раскрывал transport objects Node.js и не блокировал последующее добавление streaming?

## Answer

В `HttpRequestContext` добавляется всегда присутствующее read-only свойство `requestBody` типа
`HttpRequestBodyReader`. Reader группирует асинхронные операции `json()`, `text()`, `bytes()` и
`formData()` и публикует read-only флаг `used`. Первая версия не добавляет дублирующие
`arrayBuffer()`/`blob()` и не обещает `stream()` до отдельного streaming-effort.

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

Reader образует отдельную границу изменения body-семантики, не раскрывает факт предварительного
буферизования и оставляет совместимое место для будущего `stream()`. JSON-тип задаётся один раз как
generic `HttpRequestContext<JsonBody>` и распространяется в `requestBody.json(): Promise<JsonBody>`.
Существующее `ctx.body`, совместимость текущих generic-параметров, результаты пустого тела и ошибки
здесь не определяются.

Прототип и рассмотренные альтернативы:
[Fetch-подобный API тела HTTP-запроса](../prototypes/request-body-api.md).
