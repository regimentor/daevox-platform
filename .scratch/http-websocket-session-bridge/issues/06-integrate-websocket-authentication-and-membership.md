Type: task
Status: ready-for-agent
Blocked by: 03, 04, 05

# Подключить Authentication и AuthSession membership к WebSocket

Аутентифицировать WebSocket handshake до `101`, передавать `AuthSession` в lifecycle и вести
локальный двусторонний индекс сессий аутентификации и соединений.

## Требования

- Расширить WebSocket options явным выбором authentication scenario либо отключением и exact Origin
  allowlist согласно [`../spec.md`](../spec.md).
- Проверять endpoint, Upgrade, subprotocol и Origin, затем запускать scenario до `onConnect` и `101`.
- Реализовать точные HTTP-отказы handshake для Origin, required/optional, `abstain`, `rejected`,
  challenge и ошибок strategy.
- Добавить неизменную подтверждённую `AuthSession` в connect/disconnect/error contexts; при optional
  `abstain` не создавать membership.
- Соблюсти порядок: validation → Origin → authentication → context → `onConnect` → `101` →
  membership → messages.
- Углубить application-owned store/hub двусторонними индексами `authSessionId -> sessionId` и
  `sessionId -> AuthSession/connection`, сохранив raw connection приватным.
- Удалять обе стороны membership ровно один раз при любом close, ошибке, отказе `onConnect`, expiry
  и shutdown.
- Если `expiresAt` задан, закрывать соединение локальным timer кодом `4001` и reason
  `Authentication expired`; не поддерживать re-authentication или перенос identity.
- Обеспечить отсутствие гонки, при которой сообщения обрабатываются до регистрации membership.
- Обновить старые WebSocket fixtures/tests явным отключением authentication и допустимой Origin
  policy согласно спецификации.

## Критерии приёмки

- Неподтверждённое соединение не получает `101`, не вызывает `onConnect` и не попадает в store.
- `clientId`/`sessionId` остаются уникальными transport IDs и не заменяются `authSessionId`.
- Несколько соединений одной `AuthSession` присутствуют в одном membership set; разные
  `AuthSession` изолированы.
- Expiry, close и shutdown очищают timer, membership и listeners без повторного `onDisconnect`.
- Production-код имеет двуязычный JSDoc; `npm run docs:build`, `npm test` и `npm run check` проходят.

## Comments
