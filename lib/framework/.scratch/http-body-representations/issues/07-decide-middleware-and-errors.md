Status: resolved
Type: grilling
Blocked by: 03, 05, 06

# Встроить чтение тела в middleware и ошибки HTTP

## Question

Когда тело принимается и разбирается относительно сопоставления HTTP-маршрута и цепочки HTTP
middleware, кто может инициировать чтение, как наблюдаются parser errors, и как однократное чтение,
отмена клиента и уже начатый shutdown влияют на выполнение HTTP-обработчика?

## Answer

После сопоставления HTTP-маршрута transport полностью читает и ограничивает wire body до создания
`HttpRequestContext` и запуска middleware. Поэтому превышение effective `bodyLimit` детерминированно
даёт ранний `413`, а middleware и HTTP-обработчик не запускаются. Ленивым является выбор и разбор
представления уже готового snapshot, а `requestBody.used` означает пользовательский вызов операции,
не состояние сетевого чтения.

Один `HttpRequestBodyReader` передаётся middleware приложения, HTTP-контроллера, HTTP-маршрута и
найденному HTTP-обработчику. Первый вызвавший операцию становится единственным потребителем.
Short-circuit middleware может не разбирать snapshot; прочитанное значение передаётся следующему
слою явно через `ctx.state`.

Публичный `HttpRequestBodyError` позволяет отличить ожидаемые ошибки reader:

- `MALFORMED_BODY` со status `400`;
- `UNSUPPORTED_MEDIA_TYPE` со status `415`.

Middleware может перехватить этот error и вернуть собственный `HttpResponse`. Неперехваченный
`HttpRequestBodyError` автоматически преобразуется transport в безопасный ответ без вызова
`http.onError`. Повторное или параллельное чтение отклоняется `TypeError`; неперехваченный
`TypeError` является programmer error, вызывает `http.onError` и даёт безопасный `500`.

Автоматические ответы сохраняют текущий wire-контракт и
`Content-Type: application/json; charset=utf-8`:

- `400` → `{"error":"Bad Request"}`;
- `413` → `{"error":"Payload Too Large"}`;
- `415` → `{"error":"Unsupported Media Type"}`.

Error code, message, cause, parser details и stack не сериализуются. Точная public TypeScript-
сигнатура `HttpRequestBodyError` определяется ticket про типы.

Если `ctx.signal` отменён до или во время операции reader, она отклоняется стандартным
`DOMException` с именем `AbortError`, не `HttpRequestBodyError`. Непрочитанный snapshot сразу
освобождается; `used` остаётся `false` до пользовательского вызова, после которого становится
`true`, даже если вызов немедленно отклоняется из-за отмены. Уже возвращённые значения не
инвалидируются.

Отмена не прерывает JavaScript middleware или HTTP-обработчик принудительно: они используют общий
`ctx.signal` для cooperative cancellation. Активные чтения входят в HTTP request lifecycle и
получают общий `http.shutdownTimeout`; forced cutoff отменяет reader и освобождает snapshot.
Отключение клиента и штатный forced cutoff не вызывают `http.onError`.

Решение явно пересматривает положение ADR 0009 о запуске HTTP middleware после разбора тела: до
middleware теперь завершается только ограниченное буферизование, а representation parsing может
инициировать middleware. Будущая спецификация и реализация обязаны обновить ADR 0009.
