Status: resolved
Blocked by: 03

# Интегрировать transport tracking и shutdown внутренних событий

## Question

Добавить строгий settlement tracking пользовательских transport-операций и встроить ограниченный drain EventListener перед `JobRunner.close()` по
[`../spec.md`](../spec.md).

## Требования

- Работать через TDD; исходники и тесты писать только в `.js`.
- Отслеживать settlement HTTP-handler отдельно от lifecycle response.
- Отслеживать WebSocket message-handler/message chains, pending upgrade, `onConnect` и `onDisconnect`.
- Добавить строгий `websocket.shutdownTimeout` с default `30000` мс.
- На shutdown прекращать новый transport-ввод, закрывать WebSocket-сессии и последовательно предоставлять HTTP- и WebSocket grace-бюджеты.
- Позволять активным transport-handler вызывать `push()` до settlement или forced cutoff, затем запечатывать sender.
- После запечатывания ждать пустых mailboxes до `events.shutdownTimeout`, а затем закрывать `Job Runner`.
- По forced event timeout отменять active signals без отдельной observer error, отбрасывать ожидающие события с `EventDroppedError` для каждого и прекращать ожидание.
- Перехватывать позднюю ошибку active event handler после cutoff, но не вызывать observer после resolution `Application.close()`.
- Не отклонять `Application.close()` только из-за отброшенных событий.
- Сохранить отдельные последовательные timeout-бюджеты HTTP, WebSocket, events и jobs.
- Сохранить неизменный идемпотентный `Application.close()` и необратимые application states.
- Добавить двуязычный JSDoc с `@public`/`@private` для production-кода.

## Критерии приёмки

- E2E race-тесты доказывают tracking HTTP-handler после response destruction, WebSocket handler после close session и pending `onConnect`.
- Покрыты cooperative settlement, forced cutoff, late `push()`, late rejection, зависший `onDisconnect` и идемпотентный close.
- Покрыты порядок закрытия WebSocket, sender, mailboxes и `Job Runner`, включая `jobRunner.run()` из listener во время drain.
- Отброшенные события наблюдаются, но не отклоняют `Application.close()`.
- Полный `npm run test:shutdown`, race-тесты и `npm run docs:build` завершаются успешно.

## Comments

Текущий shutdown не отслеживает WebSocket message chains и pending upgrade, а HTTP active set связан с response close; задача намеренно пересматривает эти гарантии по ADR 0011.

Transport settlement tracking, запечатывание sender, bounded drain и forced cutoff реализованы и покрыты HTTP/WebSocket e2e-тестами shutdown.
