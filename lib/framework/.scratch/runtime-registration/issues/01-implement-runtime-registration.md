Status: ready-for-agent
Type: task

# Реализовать runtime-регистрацию контроллеров и EventListener

Реализовать принятый контракт [`../spec.md`](../spec.md) через публичный interface `Application`,
сохранив отдельные startup- и runtime-операции регистрации.

## Требования

- Добавить синхронные fluent-методы `registerRuntimeHttpController()`,
  `registerRuntimeWebSocketController()` и `registerRuntimeEventListener()`.
- Сохранить `registerHttpController()`, `registerWebSocketController()` и
  `registerEventListener()` только для состояния `new`.
- Открывать runtime-регистрацию только после успешного завершения `onAppStart()` и fulfillment
  `listen()`; runtime-вызовы внутри startup hooks должны получать `ApplicationStateError`.
- Синхронно закрывать runtime-регистрацию в начале `close()` и отклонять её после failed startup,
  во время `closing` и после `closed`.
- Вынести общие внутренние операции HTTP- и WebSocket-регистрации, чтобы startup- и
  runtime-методы использовали одну валидацию, snapshot metadata, conflict detection и публикацию.
- Сохранить существующие generic-типы и registration-time проверки literal handler,
  `TAppState`, context и transport-result для новых методов.
- Углубить внутренний events module одной атомарной операцией runtime-активации: проверить и
  скопировать metadata, создать listener с принадлежащими приложению зависимостями и mailbox,
  повторно проверить readiness/conflicts после выполнения пользовательского конструктора, затем
  опубликовать registry entry и mailbox без пользовательского кода между этими шагами.
- Пробрасывать ошибку конструктора runtime-listener без обёртки; после ошибки не должны быть видны
  metadata, адрес или mailbox, а приложение должно остаться готовым к новой регистрации.
- Listener, полностью зарегистрированный до `close()`, должен участвовать в существующем event
  drain и forced cutoff. Регистрация, начатая после синхронного перехода в `closing`, должна быть
  отклонена без частичного состояния.
- Создать ADR `0015-runtime-registration.md`, явно пересматривающий startup-only положения ADR
  0003 и ADR 0011 и фиксирующий readiness, атомарность и registration/close ordering.
- Обновить README, capability-страницы HTTP, WebSocket, application events и Application,
  двуязычный JSDoc с `@public`/`@private` и generated API.
- Сохранить вне scope удаление, замену, unload, hot reload, batch-транзакции и публичную инспекцию
  каталогов.

## Критерии приёмки

- До runtime-регистрации неизвестный HTTP-маршрут возвращает `404`; после успешной регистрации
  реальный HTTP-запрос получает ответ нового controller. Неуспешный conflict не меняет каталог.
- Существующая WebSocket-сессия получает `UNKNOWN_CONTROLLER` до регистрации и успешно выполняет
  то же сообщение после регистрации. Неуспешный conflict не нарушает существующие адреса.
- После runtime-регистрации listener `EventSender.push()` принимает его адрес, сохраняет DTO,
  FIFO, handler timeout и error-isolation контракты.
- Runtime-методы отклоняются до `listen()`, внутри `beforeAppStart()` и `onAppStart()`, после
  failed startup, во время `closing` и после `closed`.
- Тесты constructor failure, invalid class, duplicate class/name/route/address подтверждают
  отсутствие частичной публикации и успешную последующую регистрацию.
- Гонка registration/close имеет два наблюдаемых исхода: завершённая регистрация входит в
  shutdown либо вызов отклоняется до публикации.
- Compile-time тесты подтверждают те же положительные и отрицательные handler/AppState контракты
  для startup- и runtime-методов.
- Все новые поведенческие тесты проходят через `Application`, `listen()`, `close()`, реальные HTTP
  и WebSocket seams; внутренние registry/dispatcher не становятся основным test surface.
- `npm run docs:build`, `npm run docs:check`, корневой `npm run verify` и
  `npm run stress --workspace @daevox/framework` завершаются успешно.

## Comments

Публичный interface, lifecycle-окно, атомарность runtime-listener и границы scope согласованы в
обсуждении задачи. На этапе создания этой записи production-код, тесты, ADR и публичная
документация не изменялись.
