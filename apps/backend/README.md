# Локальное подключение Telegram

Backend слушает `127.0.0.1:3000`. Экран подключения работает без входа в Daevox.
`GET /healthcheck` проверяет только доступность backend; отсутствие настроек Telegram не мешает
healthcheck и `GET /api/telegram/state`.

## Подготовка

1. Использовать Node.js 26 с `node:ffi` и npm 12. Установить зависимости из корня: `npm install`.
2. Подготовить закреплённую TDLib: `npm run build -w @daevox/tdlib`.
   Системные требования описаны в [README TDLib](../../lib/tdlib/README.md).
   Если соответствующий native artifact уже собран, повторная сборка не нужна.
3. Скопировать корневой `.env.example` в `.env` и заполнить локально:
   - `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` — реквизиты собственного Telegram API-приложения;
   - `TELEGRAM_DATABASE_KEY` — стабильный ключ из 32 случайных байтов в base64;
   - `TELEGRAM_DATABASE_DIRECTORY`, `TELEGRAM_FILES_DIRECTORY` — разные абсолютные пути вне
     репозитория. TDLib создаёт и использует их постоянно. Не направлять два процесса на одну базу.
4. Сохранить ключ и каталоги между запусками. Не передавать реквизиты и ключ в браузер или чат.
   `.env` исключён из Git. Сессия хранится вне репозитория; удаление её файлов не заменяет выход.

Пример локальной генерации ключа (вывод вставить только в `.env`):

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## Запуск

В двух терминалах из корня:

```sh
npm run dev -w @daevox/backend
npm run dev -w @daevox/web-client -- --host 127.0.0.1
```

Открыть `http://127.0.0.1:5173/telegram`. Для других портов согласованно изменить `PORT`,
`WEB_CLIENT_ORIGIN`, `API_PROXY_TARGET` в корневом `.env` и порт запуска web-client.
Frontend отправляет относительные запросы `/api/*` на свой origin. Vite перенаправляет их в backend
по `API_PROXY_TARGET` (по умолчанию `http://127.0.0.1:3000`), поэтому браузеру не нужны CORS и preflight.
`VITE_API_BASE_URL` больше не используется. Dev-сервер по умолчанию слушает `127.0.0.1:5173`
и не переключается автоматически на другой порт.

Vite меняет Host на адрес backend и сохраняет исходный Origin. Проверка локального Host/Origin
в backend остаётся: `WEB_CLIENT_ORIGIN` должен совпадать с адресом frontend, включая
`localhost` / `127.0.0.1`. Для production-сборки нужен reverse proxy `/api/*` на backend
под тем же origin, поскольку Vite dev proxy там не работает.

Нажать «Подключить Telegram», отсканировать QR в Telegram → Настройки → Устройства → Подключить
устройство. При наличии 2FA ввести пароль на экране. QR кодируется локально; пароль очищается
после отправки. Native-логи выключаются до передачи параметров авторизации.

Штатная остановка через SIGINT/SIGTERM сохраняет сессию. «Отключить аккаунт» вызывает `logOut`;
успех отображается после `Closed` и освобождения клиента. При отсутствии сети нужно дождаться
Telegram. Перезапуск может продолжить записанный TDLib выход, но приложение само не хранит и
не повторяет это намерение. Фатальная ошибка требует явного перезапуска подключения.

## Проверка

```sh
npm run verify -w @daevox/telegram-contract
npm run verify -w @daevox/backend
npm run verify -w @daevox/web-client
npm exec -w @daevox/web-client -- playwright install chromium
npm run test:e2e -w @daevox/web-client
npm run verify -w @daevox/tdlib
npm run lint
npm run format:check
```

Browser e2e запускает отдельный HTTP backend с управляемым transport TDLib на `127.0.0.1:3001`
и web-client на `127.0.0.1:5174` с Vite proxy на тестовый backend; эти порты должны быть свободны. Тестовый entrypoint не загружается
production bootstrap. Реальные реквизиты и сессия в тестах не используются. Трассировка браузера
отключена, чтобы не сохранять тела запросов авторизации.

Приёмка реального аккаунта выполняется по [спецификации](../../.scratch/telegram-qr-auth/spec.md):
ротация QR, вход с существующей настройкой 2FA, повторное открытие страницы, перезапуск backend,
выход с проверкой сессии в Telegram, повторный вход. Native offline smoke и автоматические сценарии
не заменяют ручной прогон.
