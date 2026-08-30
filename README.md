# Daevox Platform

Daevox Platform — платформа для agentic-задач. Целевые возможности и границы компонентов
описаны в [обзоре платформы](docs/platform.md).

Монорепозиторий управляется через npm workspaces. Каждый публикуемый или исполняемый module
владеет своим production-кодом, тестами, примерами и документацией.

## Workspaces

- [`@daevox/web-client`](apps/web-client/) — frontend Daevox Platform.
- [`@daevox/backend`](apps/backend/) — HTTP backend Daevox Platform.
- [`@daevox/framework`](lib/framework/README.md) — транспортный фреймворк Node.js 26 без
  runtime-зависимостей, разрабатываемый как основа backend.

## Backend

Backend запускается на порту `3000` по умолчанию. Порт можно переопределить переменной окружения
`PORT`.

```sh
npm run dev --workspace @daevox/backend
```

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

`npm run verify` запускает для каждого workspace статические проверки, unit- и e2e-тесты,
проверки вспомогательных harness'ов и короткий soak-harness.

Команду одного module можно запустить через npm workspace:

```sh
npm run test:unit --workspace @daevox/framework
```
