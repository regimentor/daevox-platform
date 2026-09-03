# Добавить классовый контракт JSON-тела HTTP-маршрута

## Destination

Получить implementation-ready спецификацию публичного interface и поведения `lib/framework`
для классового контракта JSON-тела, объявляемого как `body: UserDto` в метаданных
HTTP-маршрута, без реализации production-кода.

## Notes

- Контекст: «Транспортный фреймворк Daevox»; использовать `grilling`, `domain-modeling`, а для
  конкретизации публичного interface — `prototype`.
- Канонический термин: «контракт JSON-тела HTTP-маршрута»
  (`HttpRouteJsonBodyContract`); он не заменяет «представление тела HTTP-запроса».
- Задача [`Расширить представления тела HTTP-запроса`](../http-body-representations/map.md) считается
  уже реализованной предпосылкой; фактически она выполняется до этой инициативы.
- При успехе framework возвращает экземпляр объявленного класса; корневый контракт должен
  охватывать все JSON-совместимые формы.
- Рекурсивные дескрипторы: `String`, `Number`, `Boolean`, `null`, прикладной класс и
  одноэлементный массив дескриптора; произвольные JSON-объекты без класса не входят в первую версию.
- Лишние поля отклоняются; отсутствующее необязательное поле остаётся `undefined` только в
  материализованном экземпляре.
- Framework вызывает public zero-argument constructor, затем присваивает проверенные поля.
- Validators синхронные; validation failure даёт безопасный `400` со стабильным code и списком
  нарушений `{ path, code, message }` без значений и внутренних error details.
- Контракт материализуется лениво поверх one-shot `HttpRequestBodyReader`; route middleware и
  HTTP-обработчик делят кэш результата одного route contract.
- Планирование по умолчанию: карта принимает решения и не меняет production-код.

## Decisions so far

- [Конкретизировать публичный interface контракта JSON-тела](issues/01-prototype-public-contract.md):
  HTTP-маршрут объявляет `body: UserDto`; прикладной класс задаёт `static schema` с едиными field
  entries `{ type, nullable?, validators? }` и optional `static validators`; route middleware и
  handler получают связанный `HttpRequestContext<UserDto>` и читают общий материализованный
  результат через `await ctx.requestBody.json()`.
- [Определить схему, рекурсию и наследование классов](issues/02-decide-schema-and-inheritance.md):
  корень принимает JSON object, строгая исчерпывающая `static schema` поддерживает primitive,
  `null`, однородные array и exact class descriptors; `bodyClass(() => Class)` разрешает циклические
  schema graphs, тогда как наследование контрактных классов и более узкие TypeScript-типы запрещены.
- [Определить материализацию и владение значениями](issues/03-decide-materialization.md): после
  полной успешной validation граф строится bottom-up точными constructors и новыми arrays; schema
  fields записываются как own data properties без setters, optional absence перезаписывает defaults
  значением `undefined`, а mutable результат принадлежит приложению и кэшируется на время запроса.
- [Определить validator contract и встроенный набор](issues/04-decide-validators.md): frozen
  pre-materialization snapshot проходит structural, field и bottom-up root phases; синхронные
  validators детерминированно агрегируют violations, `required()` управляет presence, а минимальный
  built-in набор состоит из length, numeric bound и integer checks со стабильными codes/messages.
- [Связать body metadata с TypeScript-типом HTTP-обработчика](issues/05-decide-route-typing.md):
  `body: UserDto` специализирует `requestBody.json()`, route middleware и literal handler через
  generics `AppState, JsonBody, State`; безопасные supertypes разрешены, dynamic/`any` declarations
  остаются runtime boundary, а startup/runtime registration используют единый proof.
- [Встроить контракт в reader и middleware lifecycle](issues/06-decide-reader-and-middleware.md):
  первый contract-aware `json()` создаёт request-local success/failure cache, к которому
  присоединяются повторные consumers; другие representations сохраняют one-shot конкуренцию,
  short-circuit оставляет контракт ленивым, а все ошибки распространяются rejected Promise.
- [Определить registration-time проверки и safety-границы](issues/07-decide-registration-and-safety.md):
  registration атомарно создаёт immutable plan из canonical non-Proxy metadata, запрещает
  inheritance и pollution keys и применяет fixed schema limits; ingress отдельно ограничен depth,
  values и violations, тогда как application callbacks остаются доверенным синхронным кодом.
- [Зафиксировать модель validation errors](issues/08-decide-validation-errors.md):
  `HttpRouteJsonBodyValidationError` специализирует `HttpRequestBodyError` кодом
  `INVALID_JSON_BODY` и frozen ordered violations с RFC 6901 paths; safe automatic `400` публикует
  codes/messages без details, а malformed validators и materialization failures остаются `500`.
- [Определить доказательства готовности реализации](issues/09-decide-acceptance-evidence.md):
  готовность доказывают public seam/type tests, расширенные fuzz/stress/benchmark/soak/mutation
  harnesses и все full gates; обязательны цельный example, README/JSDoc/generated/interface docs,
  новый ADR контракта и обновление ADR 0009.

## Not yet specified

Нет: все решения, необходимые для implementation-ready спецификации, зафиксированы в закрытых
дочерних tickets и сведены в [`spec.md`](spec.md).

## Out of scope

- Декодирование text, bytes, URL-encoded и multipart-представлений: инициатива работает только поверх JSON.
- Контракты тела HTTP-ответа, WebSocket-сообщения и внутренних событий.
- Асинхронные validators, I/O-проверки и прикладные проверки, требующие состояния или инфраструктуры.
- Несхематизированные произвольные JSON-объекты, coercion, defaults, transforms и кастомные декодеры.
