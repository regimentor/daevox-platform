Status: needs-info
Type: task

# Сделать framework generic по типу AppState

Расширить принятый контракт [`../spec.md`](../spec.md): конкретный тип состояния, выведенный из
переданного `Application` конструктора, должен сохраняться во всех HTTP- и WebSocket-seams и
статически проверять middleware, callbacks и handler-методы.

## Требования

- Сделать `Application<TAppState>` generic с выводом `TAppState` из
  `new Application({ appState: ConcreteAppState })`.
- Сохранить поддержку прикладных классов состояния без lifecycle hooks и без наследования от
  framework-класса.
- Провести `TAppState` через `ApplicationOptions`, HTTP- и WebSocket-options, middleware,
  lifecycle/error callbacks, декларации контроллеров и событий, registries, transports и внутренние
  normalized-типы.
- Сделать `AppState`, `HttpMiddleware`, `HttpControllerClass`, `HttpRouteDeclaration`,
  `WebSocketMessageMiddleware`, `WebSocketControllerClass` и связанные публичные типы generic.
- Сохранить default `AppStateInstance` для публичных типов без generic-аргумента, чтобы существующие
  type imports продолжали работать.
- Добавить и экспортировать типы HTTP- и WebSocket-handler, принимающие первым аргументом
  `TAppState` и возвращающие результат соответствующего transport-контракта.
- Сохранить class-based interface контроллеров и строковые значения `handler` в metadata.
- На seam регистрации контроллера по literal metadata статически проверять наличие указанного
  instance-метода, совместимость его `TAppState`, context и возвращаемого типа.
- Зафиксировать `as const` для `routes` и `events` как требование статической проверки handler-имён;
  обновить framework-примеры и внутренние fixtures.
- Сохранить runtime-валидацию контроллеров, metadata и handler results для JavaScript-потребителей и
  намеренно некорректных test fixtures.
- Не менять runtime routing, порядок middleware, lifecycle, shutdown и обработку ошибок.
- Не передавать AppState в Worker jobs и application-event listeners: это остаётся вне принятого
  AppState-контракта.
- Обновить двуязычный JSDoc, README, interface/API-документацию и generated docs.

## Критерии приёмки

- Из `new Application({ appState: ConcreteAppState })` выводится `Application<ConcreteAppState>`.
- Прикладные методы `ConcreteAppState` доступны без cast во всех HTTP- и WebSocket-middleware,
  callbacks и handlers.
- Регистрация отклоняет controller middleware или handler с несовместимым AppState.
- Регистрация отклоняет отсутствующий строковый handler, неверный context и неверный возвращаемый
  тип.
- HTTP- и WebSocket-контроллеры с корректными literal declarations успешно регистрируются.
- Общее middleware, принимающее `AppStateInstance`, остаётся применимо к приложению с конкретным
  AppState.
- Публичные generic-типы без явного type argument сохраняют прежнее значение по умолчанию.
- Класс AppState без lifecycle hooks остаётся допустимым.
- Runtime-негативные тесты используют локальные явные casts и продолжают проверять runtime-контракт.
- Публичное поведение HTTP, WebSocket и lifecycle не меняется.
- `npm run docs:build`, `npm run docs:check` и корневой `npm run verify` завершаются успешно.

## Comments

Задача создана после воспроизведения несовместимости прикладного `AppState` с общим
`HttpMiddleware`: текущий `Application` теряет конкретный тип состояния на seam регистрации
контроллера. Выбрана полная generic-модель для HTTP и WebSocket с проверкой строковых handlers при
регистрации; controller factory и отдельные metadata helpers не входят в scope.

Generic-модель, compile-time проверки, framework fixtures, документация и generated API выполнены;
`npm run verify --workspace @daevox/framework` проходит полностью. Корневой `npm run verify`
останавливается на прикладном `DialogsController.sendMessage(): void`: новый registration seam
корректно отклоняет HTTP-handler без `HttpResponse`. Для завершения нужен ожидаемый прикладной
ответ или реализация `sendMessage`; production-cast намеренно не добавлен.
