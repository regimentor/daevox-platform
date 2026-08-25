Type: task
Status: ready-for-agent
Blocked by: 03

# Подключить Authentication к HTTP-маршрутам

Расширить exact-key декларацию HTTP-маршрута и выполнять выбранный authentication scenario до
чтения request body.

## Требования

- Расширить `HttpRouteDeclaration` обязательным явным выбором scenario либо отключением
  authentication согласно [`../spec.md`](../spec.md).
- Строго проверять поле при регистрации HTTP-контроллера и сохранять его в нормализованном маршруте.
- Передать `Authentication` в `Application` через выбранную спецификацией конфигурацию и проверить
  ссылки маршрутов на существующие scenarios до запуска listener.
- После сопоставления маршрута сформировать нормализованный strategy input и выполнить scenario до
  чтения body.
- Реализовать точные ответы required/optional, `abstain`, `rejected`, challenge и ошибок strategy.
- Не читать ни одного body chunk и не создавать HTTP-контроллер при отказе authentication.
- Добавить подтверждённую `AuthSession` в `HttpRequestContext` только в форме, разрешённой
  спецификацией; transport objects и raw credential не раскрывать.
- Обновить существующие HTTP-контроллеры, fixtures и tests явным отключением authentication там,
  где старое поведение должно сохраниться.
- Добавить integration-тесты на порядок route match → authentication → body read, отмену клиента,
  optional route, challenge, invalid credential и отсутствие вызова handler при отказе.

## Критерии приёмки

- Authentication не выполняется для `404`, автоматического `OPTIONS` и других входов без выбранного
  HTTP-маршрута.
- Отказ authentication происходит до body-limit/media-type/JSON ошибок и не читает тело.
- Optional `abstain` вызывает handler без `AuthSession`; authenticated result передаёт ровно
  нормализованную session.
- Старые HTTP-сценарии работают после явного `authentication: false`.
- Production-код имеет двуязычный JSDoc; `npm run docs:build`, `npm test` и `npm run check` проходят.

## Comments
