# Пользовательская документация Daevox Node Framework

Daevox — транспортный фреймворк для ESM-приложений на Node.js 26. Он запускает HTTP и WebSocket
на одном `node:http` server, маршрутизирует запросы в декларативные контроллеры и выполняет
фоновые задачи в пуле `worker_threads`. Runtime-зависимостей у фреймворка нет.

## С чего начать

1. [Установка и первое приложение](getting-started.md) — требования, импорты и минимальный запуск.
2. [Приложение и жизненный цикл](application.md) — конфигурация, регистрация, запуск и остановка.
3. [HTTP](http.md) — HTTP-контроллеры, маршруты, запросы, ответы и ожидаемые ошибки.
4. [Authentication](authentication.md) — strategies, scenarios, `AuthSession` и готовые adapters.
5. [WebSocket](websocket.md) — endpoint, протокол `daevox.v1`, lifecycle и server push.
6. [Фоновые задачи](jobs.md) — `Job`, Worker Pool, отмена, тайм-ауты и ограничения данных.
7. [Ошибки и диагностика](errors.md) — ошибки конфигурации и выполнения, наблюдаемость и HTTP-коды.

Полный сгенерированный справочник классов, функций и типов находится в [API.md](API.md). Его
HTML-версию можно открыть командой `npm run docs:serve` после `npm install`.

## Границы фреймворка

Фреймворк отвечает за транспорт, проверку деклараций, маршрутизацию, жизненный цикл и изолированное
выполнение задач. Код приложения отвечает за бизнес-правила, хранение данных, authorization,
authoritative session state, выпуск и отзыв credentials, распределённый WebSocket fan-out,
гарантированную доставку событий и retries.

Публичной библиотечной точки входа пока нет. После установки пакета импортируйте поддерживаемые
сущности из `daevox-node-framework/lib/framework/*.js`. Внутренние `HttpRouter`, `JobRunner`,
`WorkerPool`, WebSocket transport и session store напрямую использовать не следует.
