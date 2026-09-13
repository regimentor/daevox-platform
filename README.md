# Daevox Platform

Daevox Platform — платформа для agentic-задач. Текущие и целевые возможности, а также границы компонентов
описаны в [обзоре платформы](docs/platform.md).

Монорепозиторий управляется через npm workspaces. Каждый публикуемый или исполняемый module
владеет своим production-кодом, тестами, примерами и документацией.

## Workspaces

- [`@daevox/web-client`](apps/web-client/README.md) — frontend Daevox Platform.
- [`@daevox/backend`](apps/backend/README.md) — локальный HTTP backend и подключение Telegram.
- [`@daevox/transcription-backend`](apps/transcription-backend/README.md) — локальный FastAPI-сервис
  транскрибации, перевода видео и русской озвучки.
- [`@daevox/db`](packages/db/README.md) — схема SQLite и доступ к данным Telegram-секретаря.
- [`@daevox/telegram-contract`](packages/telegram-contract/) — общие DTO Telegram API.
- [`@daevox/tdlib`](lib/tdlib/README.md) — типизированный клиент TDLib.
- [`@daevox/framework`](lib/framework/README.md) — транспортный фреймворк Node.js 26 без
  runtime-зависимостей, используемый основным backend.

## Backend

Backend слушает `127.0.0.1:3000` по умолчанию. Порт можно переопределить переменной окружения
`PORT`.

```sh
npm run dev --workspace @daevox/backend
```

Настройка реквизитов, native runtime и экрана `/telegram` описана в
[инструкции подключения Telegram](apps/backend/README.md).

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

## Транскрибация и озвучка

`transcription-backend` обслуживает вкладки `/transcription` и `/voiceover` веб-клиента.
API по умолчанию слушает `127.0.0.1:3001` и запускается отдельно от основного backend:

```sh
npm run dev --workspace @daevox/transcription-backend
npm run dev --workspace @daevox/web-client
```

Команды запускаются в отдельных терминалах. Для работы нужны uv, Python 3.12
(устанавливается через uv), FFmpeg/ffprobe с shared libraries и NVIDIA GPU.
Настройки читаются из корневого `.env`; модели загружаются при запуске обработки.
Подготовка моделей, доступ к Community-1, настройки GPU, локальной LLM и синтеза речи
описаны в [README сервиса](apps/transcription-backend/README.md).

Проверки сервиса не требуют GPU и не скачивают модели:

```sh
npm run verify --workspace @daevox/transcription-backend
```

## Возможности платформы

- Подключение Telegram через QR-код и пароль 2FA, сохранение сессии, отключение и повторное подключение.
- Telegram-секретарь: выбор чатов для наблюдения, импорт истории за 30 дней в SQLite-архив,
  дневные и разовые сводки через локальный `llama-server`.
- Автоответчик для выбранных чатов: генерация ответа по последней сводке, очередь отправки,
  защита от дублей и отображение состояния доставки.
- Транскрибация файлов и публичных записей YouTube: GigaAM-v3 для русского, Whisper large-v3
  для английского, определение спикеров через pyannote Community-1 и экспорт TXT/JSON.
- Перевод английского видео с русской озвучкой: назначение голосов спикерам, подгонка фраз
  по времени, просмотр во время обработки и сохранение видео и отдельной аудиодорожки.
- Типизированный TDLib-клиент на Node.js 26 с native FFI и общие контракты API Telegram.
- Scheduled tasks во framework с cron-расписанием, контролем жизненного цикла и выполнением через Worker Pool.

## Разработка

```sh
npm install
npm run verify
```

`npm run verify` запускает предусмотренные workspace проверки. Browser e2e веб-клиента
запускаются отдельно; команды для Telegram, транскрибации и озвучки перечислены в
[README веб-клиента](apps/web-client/README.md).

Команду одного module можно запустить через npm workspace:

```sh
npm run test:unit --workspace @daevox/framework
```
