# Расширить представления тела HTTP-запроса

## Destination

Получить implementation-ready спецификацию публичного interface и поведения `lib/framework` для
чтения входящего тела HTTP-запроса не только как JSON, включая формы и файлы, без реализации
production-кода.

## Notes

- Контекст: «Транспортный фреймворк Daevox»; использовать `grilling`, `domain-modeling`, а для
  конкретизации публичного interface — `prototype`.
- Канонический термин инициативы: «представление тела HTTP-запроса», не «объект» или `payload`.
- Целевой interface — ленивые Fetch-подобные методы чтения на `HttpRequestContext`.
- Встроенный набор должен покрывать JSON, текст, URL-encoded и multipart-формы; остальные media
  types доступны как bytes escape hatch без реестра пользовательских декодеров.
- Текущая инициатива использует ограниченное буферизованное чтение. Streaming выносится в отдельный
  effort, но выбранный interface не должен блокировать совместимое добавление streaming позднее.
- Планирование по умолчанию: карта принимает решения и не меняет production-код.

## Decisions so far

- [Выбрать основу для multipart-парсинга](issues/01-research-multipart-parsing.md): bounded/eager
  разбор использует встроенный `Response.formData()` без runtime-зависимости; отдельные multipart-
  лимиты и `@fastify/busboy` остаются кандидатом для будущего streaming.
- [Конкретизировать Fetch-подобный API чтения тела](issues/02-prototype-request-body-api.md):
  `ctx.requestBody` всегда предоставляет асинхронные `json()`, `text()`, `bytes()`, `formData()` и
  флаг `used`; JSON-тип приходит из generic `HttpRequestContext<JsonBody>`, streaming и
  дублирующие byte-формы пока не публикуются.
- [Определить однократное чтение и совместимость с ctx.body](issues/03-decide-consumption-and-compatibility.md):
  первый вызов необратимо потребляет общий reader, middleware делится результатом через `ctx.state`,
  а синхронное `ctx.body` удаляется с сохранением порядка generic-параметров контекста.
- [Зафиксировать значения представлений тела HTTP-запроса](issues/04-decide-body-values.md): JSON
  сохраняет все стандартные значения, bytes возвращаются независимым `Buffer`, а формы — нативными
  `FormData`/`File` с in-memory владением и недоверенным `File.name`.
- [Определить правила Content-Type и кодировок](issues/05-decide-media-type-rules.md): JSON и формы
  проверяют media type, text/bytes остаются escape hatch, ошибки делятся на `400`/`413`/`415`, а
  `formData()` сохраняет tolerant-семантику нативного parser Node.js 26.
- [Определить лимиты и жизненный цикл файлов](issues/06-decide-limits-and-file-lifecycle.md): единый
  глобальный/маршрутный aggregate limit принимает bytes или строгие SI/IEC size-строки, а все
  загруженные значения живут в памяти независимо от request lifecycle.
- [Встроить чтение тела в middleware и ошибки HTTP](issues/07-decide-middleware-and-errors.md):
  transport буферизует до middleware, reader разбирает по требованию, ожидаемые body errors дают
  безопасные `400`/`413`/`415`, а отмена использует cooperative `AbortError` и общий HTTP shutdown.
- [Зафиксировать типы и seam будущего streaming](issues/08-decide-types-and-streaming-seam.md):
  public generics проходят от контекста в reader/handler/middleware, экспортируются body error и
  `ByteSize`, а будущий Web `ReadableStream` сможет дополнить reader без раскрытия Node transport.
- [Определить доказательства готовности реализации](issues/09-decide-acceptance-evidence.md): public
  seam и type tests, полные fuzz/stress/benchmark/soak/mutation профили, документация, ADR 0009 и
  полная breaking migration являются обязательным acceptance gate.

## Not yet specified

Нет: все решения, необходимые для implementation-ready спецификации, зафиксированы в закрытых
дочерних tickets.

## Out of scope

- Расширение значений исходящего `HttpResponse.body`: ответы уже поддерживают JSON, строки,
  `Buffer` и `Uint8Array` и требуют отдельной инициативы для дальнейшего расширения.
- Реализация streaming, backpressure и потокового multipart-парсинга; здесь фиксируется только
  совместимая точка будущего расширения.
- WebSocket-сообщения и их JSON-протокол.
- Публичный реестр пользовательских body-декодеров.
