Type: task
Status: ready-for-agent
Blocked by: 02

# Добавить ограниченную WebSocket write queue и backpressure

Углубить внутренний `WebSocketConnection`, чтобы все реактивные ответы и будущий server push
использовали одну ограниченную byte-based FIFO с детерминированной семантикой slow consumer.

## Требования

- Реализовать byte-based FIFO для полностью сериализованных WebSocket frames.
- Использовать лимит и default из завершённой [`../spec.md`](../spec.md); строго валидировать
  соответствующую WebSocket option.
- Сохранять порядок enqueue одного connection для ответов, ошибок протокола, close и будущего push.
- После `socket.write() === false` не писать следующий frame до `drain`.
- При переполнении учитывать непоставленный frame как dropped и начинать закрытие slow consumer
  кодом `1013` с согласованной reason.
- Не допускать повторного close, записи после close и зависания очереди при `error`, `end`, `close`
  или shutdown.
- Предоставить внутренний результат enqueue, достаточный для будущего подсчёта `queued/dropped`, не
  раскрывая socket публично.
- Сохранить существующую семантику `maxPayload`: encoder ограничивает envelope, очередь ограничивает
  суммарные framed bytes.
- Добавить детерминированные unit/integration-тесты с управляемым fake socket и событиями `drain`.

## Критерии приёмки

- Медленный socket не создаёт неограниченного пользовательского буфера.
- Frames одного connection записываются FIFO и возобновляются только после `drain`.
- Переполнение закрывает соединение ровно один раз кодом `1013` и освобождает очередь/listeners.
- Текущие WebSocket protocol tests сохраняют наблюдаемое поведение.
- Production-код имеет двуязычный JSDoc; `npm run docs:build` и `npm run check` проходят.

## Comments
