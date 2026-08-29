# Daevox

Монорепозиторий Daevox управляется через npm workspaces. Каждый публикуемый или исполняемый
module владеет своим production-кодом, тестами, примерами и документацией.

## Workspaces

- [`@daevox/framework`](lib/framework/README.md) — транспортный фреймворк Node.js 26 без
  runtime-зависимостей.

## Разработка

```sh
npm install
npm test
npm run check
```

Команду одного module можно запустить через npm workspace:

```sh
npm run test:unit --workspace @daevox/framework
```
