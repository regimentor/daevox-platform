Type: task
Status: ready-for-agent

# Завершить исполнимую спецификацию Authentication и server push

Превратить решения ADR 0009 и исследования в точный public contract, по которому последующие
задачи смогут писать код и тесты без локальных архитектурных догадок.

## Требования

- Заполнить раздел «Контракт, завершаемый до реализации» в [`../spec.md`](../spec.md).
- Задать exact-key формы конфигурации `Application`, `Authentication`, strategies, scenarios,
  `AuthSession`, tagged results, HTTP-маршрута и WebSocket options.
- Определить обязательность каждого поля, defaults, правила копирования/заморозки и момент
  синхронной проверки ссылок на strategy/scenario.
- Зафиксировать нормализованный strategy input отдельно для HTTP и WebSocket без transport objects.
- Зафиксировать transport mapping для required/optional, `abstain`, `rejected`, thrown errors и
  challenge, включая точные HTTP statuses и отказ WebSocket handshake до `101`.
- Определить exact Origin allowlist, поведение отсутствующего `Origin` у non-browser клиента и
  взаимодействие allowlist с отключённой authentication.
- Определить имена, defaults и validation лимита WebSocket write queue.
- Определить connect/disconnect/error contexts, `expiresAt` timer и гарантии cleanup при гонках
  connect, close, expiry и shutdown.
- Зафиксировать public errors и точные callback-контракты `cookieSession`, `bearerToken` и
  `oneTimeWebSocketTicket`, не вводя session store или provider в framework.
- Не менять production-код в этой задаче.

## Критерии приёмки

- В `spec.md` нет TBD, альтернатив без выбора и требований, зависящих от догадки исполнителя.
- Контракт не вводит custom scenario, generation/revocation, distributed adapter или authorization.
- Все примеры используют только `.js` и согласованы с `CONTEXT.md`, README и ADR 0009.
- Текст однозначно задаёт негативные сценарии и ожидаемые наблюдаемые результаты.
- Форматирование Markdown проходит `npm run format:check`.

## Comments
