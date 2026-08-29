Status: resolved

# Обновить документацию и WebSocket example для daevox.v1

После реализации протокола обновить публичную документацию и пример приложения по [`../spec.md`](../spec.md).

## Требования

- Заменить старый WebSocket-раздел README контрактом единого endpoint, `daevox.v1`, controller metadata, handler context, hooks и ошибок.
- Переписать WebSocket example на `static name`, `static events` и необязательный реактивный ответ.
- Клиент example обязан подключаться с subprotocol `daevox.v1` и отправлять точный `{ controller, event, body }`.
- Удалить из документации утверждения о controller lifecycle hooks, raw text/binary data и `clientSessions`.
- Сверить терминологию с `CONTEXT.md` и архитектуру с ADR 0008.

## Критерии приёмки

- README описывает фактически реализованный публичный API и не смешивает старую и новую модели.
- Example запускается документированной npm-командой и демонстрирует ответ с исходными `controller/event`.
- Все файлы примера остаются JavaScript `.js`.
- `npm run check` завершается успешно.

## Comments

README и WebSocket example переведены на `daevox.v1`, `static name/events`, единый `/websocket` и необязательный реактивный ответ. Упоминания старых path-based lifecycle-контроллеров и `clientSessions` удалены.
