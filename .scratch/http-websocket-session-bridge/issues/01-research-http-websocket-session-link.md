Type: research
Status: ready-for-human

# Исследовать связь HTTP-запроса и WebSocket-сессий

## Question

Как позволить HTTP-обработчику отправить WebSocket-событие только соединениям той же сессии
аутентификации, не смешивая её с `WebSocketSession` и `WebSocketClient`, и при этом поддержать
явно выбираемые пользовательские authentication strategies и scenarios?

## Answer

Исследование завершено. Результат вынесен в [`../research.md`](../research.md), архитектурное решение
зафиксировано в [ADR 0009](../../../docs/adr/0009-auth-session-websocket-server-push.md), а исполнимая
спецификация и задачи реализации находятся в [`../spec.md`](../spec.md) и соседних issue-файлах.

## Comments

Полный исследовательский артефакт отделён от задачи, чтобы `issues/` оставался каталогом работ и их
статусов.
