# HTTP/WebSocket session bridge: отложенный scope

Этот документ фиксирует сознательно исключённые из первой версии возможности. Они не являются
скрытыми требованиями к реализации ADR 0009 и должны возвращаться в работу только отдельными
исследованиями и архитектурными решениями.

## Stateful lifecycle сессии аутентификации

Framework не поставляет authoritative session store, `AuthSessionAuthority`, logout/revocation
protocol, generation/version сессии, periodic `revalidate()` или distributed invalidation.
Пользовательская stateful strategy сама обращается к Redis, SQL или другому источнику истины.

Отдельное исследование понадобится, если framework должен будет закрывать уже открытые соединения
при досрочном logout/revocation, а не только по локально известному `expiresAt`.

## Другие области адресации

Первая версия адресует все WebSocket-сессии только текущей `AuthSession`. Отложены:

- точная вкладка или конкретное соединение через проверяемый connection capability;
- account-wide, device-wide и principal-wide fan-out;
- глобальный привилегированный sender для административных операций и фоновых задач;
- встроенная guest session для анонимных HTTP/WS-клиентов.

Каждая из этих возможностей требует собственной модели полномочий и индексов; `principal.id` и
транспортный `sessionId` не должны неявно становиться адресом.

## Multi-process и multi-node доставка

Первая версия использует только in-process hub. Публичный distributed adapter, Redis Pub/Sub или
Streams, presence directory, node identity, межпроцессный revoke и гарантии при падении процесса
отложены. До отдельного решения приложение должно обеспечить совместное попадание связанных HTTP и
WebSocket connections в один экземпляр `Application` либо реализовать внешний fan-out самостоятельно.

## Durable delivery и атомарность

Отложены транзакционный outbox, commit business state вместе с событием, стабильный `eventId`,
client acknowledgement, deduplication, replay и reconciliation после reconnect. Прямой
`ctx.webSocket.send()` остаётся best-effort сигналом и не образует транзакцию с пользовательским
хранилищем.

## Повторная authentication долгого соединения

Periodic revalidation, обновление идентичности внутри открытого WebSocket и re-authentication без
нового handshake не поддерживаются. При истечении `AuthSession` framework закрывает старое
соединение по локально известному `expiresAt`; клиент может создать новое соединение только через
новый handshake. Более сложный lifecycle требует отдельного протокольного решения.
