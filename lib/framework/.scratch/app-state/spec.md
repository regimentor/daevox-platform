# AppState приложения

Status: accepted

## Назначение

Добавить в `Application` обязательный прикладной класс состояния, экземпляр которого создаётся
фреймворком один раз и используется всеми HTTP- и WebSocket-обработчиками приложения.

## Контракт

Приложение создаётся передачей класса, а не экземпляра:

```ts
const application = new Application({ appState: AppState });
```

Класс имеет конструктор без аргументов и не обязан наследоваться от класса фреймворка. Hooks
`beforeAppStart`, `onAppStart` и `onAppClose` необязательны и могут быть синхронными или
асинхронными.

Фреймворк создаёт один экземпляр `AppState` в конструкторе `Application` и передаёт тот же
экземпляр первым аргументом во все HTTP- и WebSocket-функции приложения: application/controller/route
middleware, HTTP handlers, WebSocket event handlers, `onConnect`, `onDisconnect` и `onError`.

`ctx.state` остаётся локальным состоянием HTTP-запроса или WebSocket-сессии и не заменяется
`AppState`.

## Lifecycle

1. `beforeAppStart()` ожидается перед запуском HTTP и WebSocket.
2. После полного создания и запуска приложения вызывается `onAppStart()`.
3. При закрытии после остановки входящего трафика и завершения HTTP/WebSocket handlers, событий и
   jobs вызывается `onAppClose()`.

Отсутствующий hook игнорируется. Ошибка `beforeAppStart` или `onAppStart` делает запуск
неуспешным; ошибка `onAppStart` инициирует shutdown. Ошибка `onAppClose` не останавливает остальные
шаги shutdown: `Application.close()` сохраняет и возвращает первую ошибку.

## Вне scope

- Передача `AppState` в Worker jobs.
- Требование наследования от framework-класса.
- Несколько экземпляров состояния на один `Application`.
