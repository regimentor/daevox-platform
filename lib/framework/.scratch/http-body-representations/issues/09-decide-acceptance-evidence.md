Status: resolved
Type: grilling
Blocked by: 05, 06, 07, 08

# Определить доказательства готовности реализации

## Question

Какие публичные seam-тесты, malformed-input corpus, resource-lifecycle проверки, fuzz/stress профили,
документация и compatibility cases должны стать обязательными критериями приёмки реализации
спецификации?
Включить явное обновление ADR 0009: HTTP middleware теперь запускается после ограниченного
буферизования, но до выбора и разбора представления тела HTTP-запроса.
Включить compile-time проверки defaults и propagation `JsonBody`/`State`, отсутствия method-level
JSON override, допустимых/недопустимых `ByteSize`, route `bodyLimit`, public exports и границы
registration-time доказательств без runtime-схемы.

## Answer

Реализация завершена только после public seam-проверок через реальные HTTP-запросы, compile-time
проверок interface, обновления документации и успешного стандартного gate из корня:

```sh
npm run docs:build --workspace @daevox/framework
npm run verify
```

README, двуязычный public/private JSDoc, generated API, capability-страницы HTTP/middleware/errors и
migration note должны описывать новый reader, ошибки, лимиты, in-memory файлы и breaking удаление
`ctx.body`. ADR 0009 явно пересматривается: HTTP middleware запускается после ограниченного
буферизования, но до выбора и разбора представления тела HTTP-запроса. Package manifest и lockfile
подтверждают отсутствие новых runtime-зависимостей.

Обязательная public seam-матрица покрывает:

- все JSON-значения, propagation generic, invalid UTF-8 и malformed JSON;
- text для отсутствующего и произвольного media type, UTF-8 и replacement character;
- точный пустой и непустой независимый изменяемый `Buffer`;
- URL-encoded повторы/порядок/tolerant percent escapes и multipart fields/files/metadata/boundary;
- `used`, повторные и параллельные операции, failure state и передачу middleware → `ctx.state`;
- глобальный/маршрутный limit, SI/IEC-строки, invalid config, `Content-Length`, chunked и граничные
  размеры;
- catchable `HttpRequestBodyError`, programmer `TypeError`, безопасные `400`/`413`/`415`/`500` и
  отсутствие parser leakage;
- disconnect, forced shutdown, освобождение snapshot и сохранение уже возвращённых значений.

Compile-time tests подтверждают defaults и propagation `JsonBody`/`State`, отсутствие method-level
JSON override, допустимые/недопустимые `ByteSize`, route `bodyLimit`, public exports и честную
границу registration-time проверки без runtime JSON-схемы.

Поскольку изменение одновременно затрагивает parsing, malformed input, shutdown, performance и
удержание ресурсов, обязательны все профильные проверки:

```sh
npm run fuzz:full --workspace @daevox/framework -- --seed <recorded-seed>
npm run stress --workspace @daevox/framework
npm run benchmark:full --workspace @daevox/framework
npm run soak:scheduled --workspace @daevox/framework
npm run mutation:changed --workspace @daevox/framework
```

Full benchmark и четырёхчасовой soak выполняются в однородном выделенном окружении. Если оно
недоступно, handoff явно фиксирует непройденный профиль и не заявляет полную проверку.

Harness’ы расширяются новым кодом, а не только запускаются в существующем виде:

- fixed и seed-based fuzz corpus получают multipart, URL-encoded, media-type parameters, invalid
  UTF-8, boundary и fragmentation/chunked cases плюс негативный контроль multipart/body-limit;
- races получают отмену HTTP body reader;
- stress получает параллельные bounded file uploads и проверку восстановления памяти;
- benchmark отдельно измеряет JSON, text и multipart parsing;
- soak повторяет file/form requests и проверяет освобождение больше не удерживаемых значений.

Breaking migration считается полной, только если `ctx.body` отсутствует в runtime и public type,
все examples/tests/harness controllers используют `await ctx.requestBody.*()`, compile-time test
отклоняет `ctx.body`, порядок `HttpRequestContext<JsonBody, State>` сохранён, а migration note
показывает прямую замену. Compatibility flag, скрытый eager JSON parsing и два параллельных API не
допускаются.
