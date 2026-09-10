# Daevox Platform

Daevox Platform — платформа для agentic-задач. Целевые возможности и границы компонентов
описаны в [обзоре платформы](docs/platform.md).

Монорепозиторий управляется через npm workspaces. Каждый публикуемый или исполняемый module
владеет своим production-кодом, тестами, примерами и документацией.

## Workspaces

- [`@daevox/web-client`](apps/web-client/) — frontend Daevox Platform.
- [`@daevox/backend`](apps/backend/README.md) — локальный HTTP backend и подключение Telegram.
- [`@daevox/telegram-contract`](packages/telegram-contract/) — общие DTO Telegram API.
- [`@daevox/tdlib`](lib/tdlib/README.md) — типизированный клиент TDLib.
- [`@daevox/framework`](lib/framework/README.md) — транспортный фреймворк Node.js 26 без
  runtime-зависимостей, разрабатываемый как основа backend.

## Backend

Backend слушает `127.0.0.1:3000` по умолчанию. Порт можно переопределить переменной окружения
`PORT`.

```sh
npm run dev --workspace @daevox/backend
```

Настройка реквизитов, native runtime и экрана `/telegram` описана в
[инструкции подключения Telegram](apps/backend/README.md).

## Возможности платформы

- Подключение Telegram через QR-код и пароль 2FA, сохранение сессии, отключение и повторное подключение.
- Telegram-секретарь: выбор чатов для наблюдения, импорт истории за 30 дней в SQLite-архив,
  дневные и разовые сводки через локальный `llama-server`.
- Автоответчик для выбранных чатов: генерация ответа по последней сводке, очередь отправки,
  защита от дублей и отображение состояния доставки.
- Типизированный TDLib-клиент на Node.js 26 с native FFI и общие контракты API Telegram.
- Scheduled tasks во framework с cron-расписанием, контролем жизненного цикла и выполнением через Worker Pool.

Проверка состояния backend доступна через `GET /healthcheck` и возвращает:

```json
{
  "status": "ok"
}
```

Проверки backend запускаются отдельно командой:

```sh
npm run verify --workspace @daevox/backend
```

## Разработка

```sh
npm install
npm run verify
```

`npm run verify` запускает предусмотренные workspace проверки. Browser e2e веб-клиента
запускаются отдельно: `npm run test:e2e -w @daevox/web-client`.

Команду одного module можно запустить через npm workspace:

```sh
npm run test:unit --workspace @daevox/framework
```
