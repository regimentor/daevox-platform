Status: resolved
Blocked by: 04

# Документировать и проверить внутренние события end-to-end

## Question

Завершить публичную документацию, examples, black-box и полную проверку адресуемых fire-and-forget событий по [`../spec.md`](../spec.md).

## Требования

- Обновить README примером DTO, `EventListenerBase`, `registerEventListener()` и `this.events.push()` из HTTP- и WebSocket-контроллеров.
- Описать fire-and-forget, in-memory at-most-once, FIFO, queue limit, timeout, main-thread ограничение и CPU-heavy работу через `jobRunner`.
- Описать синхронные push errors, изоляцию handler errors, `events.onError` и семантику shutdown.
- Обновить архитектурное описание фреймворка и ссылки на ADR 0011.
- Добавить минимальный запускаемый example без runtime-зависимостей.
- Добавить black-box проверку публичных экспортов и работы через реальные HTTP/WebSocket транспорты.
- Доказать, что HTTP-ответ и WebSocket-результат не зависят от позднейшего success/error listener.
- Добавить релевантную stress/smoke-проверку queue overflow, параллельных listener и отсутствия unhandled rejection.
- Не документировать pub/sub, persistence, retry, listener middleware, flush или mailbox inspection.
- Выполнить `npm run docs:build` после всех изменений production JSDoc.

## Критерии приёмки

- README достаточно для регистрации listener, отправки DTO и наблюдения ошибок без чтения исходников.
- Black-box тест подтверждает публичные imports, fire-and-forget и изоляцию ошибок обоих транспортов.
- Shutdown/race-тесты подтверждают порядок transport → events → jobs и forced cutoff.
- Все исходные и тестовые файлы имеют расширение `.js`; runtime-зависимости не добавлены.
- `npm run check`, `npm test` и релевантные stress/smoke-проверки завершаются успешно.

## Comments

Глоссарий и ADR 0011 уже созданы во время grilling-сессии; их нужно сверить с фактическим публичным контрактом после реализации.

README, capability-карта, generated API, runnable example, e2e, stress и soak проверки приведены в соответствие с реализованным контрактом.
